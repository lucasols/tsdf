import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_array, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ListQueryOfflineOperationDefinition } from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import {
  type CreateListQueryUserOperations,
  deleteItemInputSchema,
  getOfflineQueueEntries,
  getOfflineQueueEntryData,
  type PatchUserOperations,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import { type CreateAndPatchListQueryUserOperations } from './offlineReplayTestShared';
import {
  classifyRetryableReplayFailure,
  collectionCreateInputSchema,
  listQueryQueryPayloadSchema,
} from './offlineTestShared';

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

describe('list-query replay', () => {
  /**
   * A users list where Linus is created while offline under a temp id and
   * renamed before reconnecting, so the queue holds the creation followed by
   * an edit that still targets the temp id.
   */
  async function queueTempCreateThenEdit(
    sessionKey: string,
    storeName: string,
  ) {
    const usersQuery = { tableId: 'users' } as const;
    let nextUserId = 3;
    const replayedOperations: Array<{
      operation: 'createUser' | 'patchUserName';
      input: { itemId: string; name: string } | { name: string };
    }> = [];
    const applyCreateUserResult = async (result: {
      id: number;
      name: string;
    }) => {
      await env.serverTable.delayedSetItem(`users||${result.id}`, result);
      return result;
    };
    const applyPatchUserResult = (input: { itemId: string; name: string }) =>
      env.serverTable
        .delayedUpdateItem(input.itemId, { name: input.name })
        .then(() => ({ name: input.name }));

    const env: ReturnType<
      typeof createListQueryStoreTestEnv<
        { id: number; name: string },
        false,
        false,
        CreateAndPatchListQueryUserOperations
      >
    > = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      CreateAndPatchListQueryUserOperations
    >(
      {
        users: [
          { id: 1, name: 'Ada' },
          { id: 2, name: 'Grace' },
        ],
      },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        storeManager: createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey: () => sessionKey,
          offlineSession: {
            network: network.config,
            classifyRetryableFailure: (error, ctx) =>
              classifyRetryableReplayFailure(error, ctx.phase),
          },
        }),
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            operations: {
              createUser: {
                inputSchema: collectionCreateInputSchema,
                kind: 'create',
                getEntityRefs: ({ input }) => [`temp:${input.name}`],
                tempEntity: {
                  buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                  reconcileServerEntity: (result) => ({
                    finalPayload: `users||${result.id}`,
                    finalData: result,
                  }),
                },
                execute: async ({ input }) => {
                  replayedOperations.push({ operation: 'createUser', input });
                  const result = { id: nextUserId, name: input.name };
                  nextUserId += 1;
                  return applyCreateUserResult(result);
                },
              },
              patchUserName: {
                inputSchema: userPatchSchema,
                kind: 'update',
                getEntityRefs: ({ input }) => [input.itemId],
                execute: ({ input }): Promise<{ name: string }> => {
                  replayedOperations.push({
                    operation: 'patchUserName',
                    input,
                  });
                  return applyPatchUserResult(input);
                },
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateItemState(
                    input.itemId,
                    (item: { id: number; name: string }) => ({
                      ...item,
                      name: input.name,
                    }),
                  );
                },
              },
            },
          },
        },
      },
    );

    const hook = renderHook(() => {
      const query = env.apiStore.useListQuery(usersQuery, {
        itemSelector: (item: { id: number; name: string }) => item.name,
      });

      env.trackItemUI('query-status', query.status);
      env.trackItemUI('query-items', query.items.join(', '));
      return query;
    });
    await flushAllTimers();

    // Queue an offline temp create so later mutations have to follow that
    // temporary payload until replay can reconcile it to a real server id.
    env.addTimelineComments('beforeNextAction', [
      'queue a temp create while offline',
    ]);
    await act(async () => {
      await env.apiStore.performMutation('temp:Linus offline', {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            'temp:Linus offline',
            { id: -1, name: 'Linus offline' },
            { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
          );
        },
        mutation: async () => {
          const result = { id: 3, name: 'Linus offline' };
          await env.serverTable.delayedSetItem('users||3', result);
          return result;
        },
        offline: { operation: 'createUser', input: { name: 'Linus offline' } },
      });
    });

    // Edit the same temp row before reconnecting. Replay should keep this edit
    // behind the create and retarget it to the final server-backed payload.
    env.addTimelineComments('beforeNextAction', [
      'edit the same temp row before reconnecting',
    ]);
    await act(async () => {
      await env.apiStore.performMutation('temp:Linus offline', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState(
            'temp:Linus offline',
            (item: { id: number; name: string }) => ({
              ...item,
              name: 'Linus edited',
            }),
          );
        },
        mutation: async () => {
          await env.serverTable.delayedUpdateItem('temp:Linus offline', {
            name: 'Linus edited',
          });
          return { name: 'Linus edited' };
        },
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'temp:Linus offline', name: 'Linus edited' },
        },
      });
    });

    return { env, hook, replayedOperations };
  }

  test('temp create replays before the queued edit and remaps it to the final server id', async () => {
    network.setOffline();
    const sessionKey = 'offline-replay-temp-create-then-edit-session';
    const storeName = 'offline-replay-temp-create-then-edit-store';
    const { env, hook, replayedOperations } = await queueTempCreateThenEdit(
      sessionKey,
      storeName,
    );

    expect(hook.result.current.items).toMatchInlineSnapshot(`
      ['Ada', 'Grace', 'Linus edited']
    `);
    expect(
      getOfflineQueueEntries(sessionKey, storeName)
        .map((entry) => {
          const data = getOfflineQueueEntryData(entry);

          return {
            input: data.input,
            operation: data.operation,
            queueOrder: data.queueOrder,
          };
        })
        .sort(
          (left, right) => Number(left.queueOrder) - Number(right.queueOrder),
        )
        .map(({ queueOrder: _queueOrder, ...entry }) => entry),
    ).toMatchInlineSnapshot(`
      - input: { name: 'Linus offline' }
        operation: 'createUser'
      - input: { itemId: 'temp:Linus offline', name: 'Linus edited' }
        operation: 'patchUserName'
    `);
    const storeEvents: unknown[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      storeEvents.push(event);
    });

    // Reconnect and drain replay. The create must run first, and the edit must
    // target the final payload produced by that create instead of the temp one.
    env.addTimelineComments('beforeNextAction', [
      'go back online and replay both queued mutations',
    ]);
    await act(async () => {
      network.goOnline();
      await Promise.resolve();
      await flushAllTimers();
      await Promise.resolve();
    });

    expect(replayedOperations).toMatchInlineSnapshot(`
      - input: { name: 'Linus offline' }
        operation: 'createUser'
      - input: { itemId: 'users||3', name: 'Linus edited' }
        operation: 'patchUserName'
    `);
    expect(hook.result.current.items).toMatchInlineSnapshot(`
      ['Ada', 'Grace', 'Linus edited']
    `);
    expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`
      id: 3
      name: 'Linus edited'
    `);
    expect(env.apiStore.getItemState('temp:Linus offline')).toBeNull();
    expect(storeEvents).toMatchInlineSnapshot(`
      - payload: { finalPayload: 'users||3', tempId: 'temp:Linus offline' }
        type: 'tempEntityReconciled'
    `);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | query-items               | query-status |
      0      | Ada, Grace                | success      | [query-status, query-items] ui-initialized
      12s    | Ada, Grace                | success      | -- queue a temp create while offline
      .      | Ada, Grace, Linus offline | success      | [query-items] ui-changed
      .      | Ada, Grace, Linus offline | success      | offline:createUser queued
      .      | Ada, Grace, Linus offline | success      | -- edit the same temp row before reconnecting
      .      | Ada, Grace, Linus edited  | success      | [query-items] ui-changed
      .      | Ada, Grace, Linus edited  | success      | offline:patchUserName queued
      .      | Ada, Grace, Linus edited  | success      | -- go back online and replay both queued mutations
      .      | Ada, Grace, Linus edited  | success      | offline:createUser replay-started
      13.2s  | Ada, Grace, Linus edited  | success      | [users||3] server-data-changed (value: {"id":3,"name":"Linus offline"})
      .      | Ada, Grace, Linus edited  | success      | offline:createUser replay-finished
      .      | Ada, Grace, Linus edited  | success      | [query-items, query-items] ui-changed
      .      | Ada, Grace, Linus edited  | success      | offline:patchUserName replay-started
      14.4s  | Ada, Grace, Linus edited  | success      | [users||3] server-data-changed (value: {"name":"Linus edited"})
      .      | Ada, Grace, Linus edited  | success      | offline:patchUserName replay-finished
      14.41s | Ada, Grace, Linus edited  | success      | 🔴 >list-fetch-started
      15.21s | Ada, Grace, Linus edited  | success      | 🔴 <list-fetch-finished (value: {"count":3})
      "
    `);

    hook.unmount();
  });

  test('a listener that throws when the creation is saved does not make the creation be sent again', async () => {
    network.setOffline();
    const sessionKey = 'offline-replay-temp-create-listener-throws-session';
    const storeName = 'offline-replay-temp-create-listener-throws-store';
    const { env, hook, replayedOperations } = await queueTempCreateThenEdit(
      sessionKey,
      storeName,
    );

    // App code that follows the record to its final payload has a bug and
    // throws when the creation is saved
    env.apiStore.storeEvents.on('tempEntityReconciled', () => {
      throw new Error('bug in the app listener');
    });

    // Reconnect and replay the queue. The listener runs after the server
    // already saved Linus, so its error must not count as a failed creation.
    await act(async () => {
      network.goOnline();
      await Promise.resolve();
      // The error is not swallowed: it is thrown out of the replay as an
      // uncaught error, which the app's error reporting sees. With fake timers
      // it surfaces from the timers flush.
      await expect(flushAllTimers()).rejects.toThrow('bug in the app listener');
      await flushAllTimers();
      await Promise.resolve();
    });

    // Linus is created only once, and the queued edit is sent for the saved
    // user instead of the temp id
    expect(replayedOperations).toMatchInlineSnapshot(`
      - input: { name: 'Linus offline' }
        operation: 'createUser'
      - input: { itemId: 'users||3', name: 'Linus edited' }
        operation: 'patchUserName'
    `);
    // Nothing is left to send or to resolve
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
    // The list shows the saved user with the edit, and the server has a single
    // Linus
    expect(hook.result.current.items).toMatchInlineSnapshot(
      `['Ada', 'Grace', 'Linus edited']`,
    );
    expect(env.serverTable.getAll()).toMatchInlineSnapshot(`
      users||1: { id: 1, name: 'Ada' }
      users||2: { id: 2, name: 'Grace' }
      users||3: { id: 3, name: 'Linus edited' }
    `);

    hook.unmount();
  });

  type CreateManyListQueryUserOperations = {
    createUsers: ListQueryOfflineOperationDefinition<
      { id: number; name: string },
      ListQueryParams,
      string,
      { name: string }[],
      unknown,
      { id: number; name: string }[]
    >;
  };

  test('batch temp-create reconciles multiple items and remaps queued edits to their final ids', async () => {
    network.setOffline();
    const sessionKey = 'offline-replay-batch-temp-create-session';
    const storeName = 'offline-replay-batch-temp-create-store';
    const usersQuery = { tableId: 'users' } as const;
    let nextUserId = 3;
    const batchCreateUserInputSchema = rc_array(rc_object({ name: rc_string }));
    const replayedOperations: Array<{
      operation: 'createUsers' | 'patchUserName';
      input: { itemId: string; name: string } | { name: string }[];
    }> = [];
    const applyBatchCreateResults = async (
      results: { id: number; name: string }[],
    ) => {
      for (const result of results) {
        await env.serverTable.delayedSetItem(`users||${result.id}`, result);
      }
      return results;
    };
    const applyPatchUserResult = (input: { itemId: string; name: string }) =>
      env.serverTable
        .delayedUpdateItem(input.itemId, { name: input.name })
        .then(() => ({ name: input.name }));

    const env: ReturnType<
      typeof createListQueryStoreTestEnv<
        { id: number; name: string },
        false,
        false,
        CreateManyListQueryUserOperations & PatchUserOperations
      >
    > = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      CreateManyListQueryUserOperations & PatchUserOperations
    >(
      {
        users: [
          { id: 1, name: 'Ada' },
          { id: 2, name: 'Grace' },
        ],
      },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        storeManager: createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey: () => sessionKey,
          offlineSession: {
            network: network.config,
            classifyRetryableFailure: (error, ctx) =>
              classifyRetryableReplayFailure(error, ctx.phase),
          },
        }),
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            operations: {
              createUsers: {
                inputSchema: batchCreateUserInputSchema,
                kind: 'create',
                getEntityRefs: ({ input }) =>
                  input.map((item) => `temp:${item.name}`),
                tempEntities: {
                  buildPendingEntities: (input, tempIds) =>
                    input.map((item, index) => ({
                      tempId: tempIds[index]!,
                      pendingEntity: { id: -1, name: item.name },
                    })),
                  reconcileServerEntities: (result, tempIds) =>
                    result.map((item, index) => ({
                      tempId: tempIds[index]!,
                      finalPayload: `users||${item.id}`,
                      finalData: item,
                    })),
                },
                execute: async ({ input }) => {
                  replayedOperations.push({ operation: 'createUsers', input });
                  const results = input.map((item) => {
                    const result = { id: nextUserId, name: item.name };
                    nextUserId += 1;
                    return result;
                  });
                  return applyBatchCreateResults(results);
                },
              },
              patchUserName: {
                inputSchema: userPatchSchema,
                kind: 'update',
                getEntityRefs: ({ input }) => [input.itemId],
                execute: ({ input }): Promise<{ name: string }> => {
                  replayedOperations.push({
                    operation: 'patchUserName',
                    input,
                  });
                  return applyPatchUserResult(input);
                },
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateItemState(
                    input.itemId,
                    (item: { id: number; name: string }) => ({
                      ...item,
                      name: input.name,
                    }),
                  );
                },
              },
            },
          },
        },
      },
    );

    const hook = renderHook(() => {
      const query = env.apiStore.useListQuery(usersQuery, {
        itemSelector: (item: { id: number; name: string }) => item.name,
      });

      env.trackItemUI('batch-query-items', query.items.join(', '));
      return query;
    });
    await flushAllTimers();

    // Queue a single batch temp-create so both later edits depend on one
    // replay operation that has to remap multiple temp payloads.
    env.addTimelineComments('beforeNextAction', [
      'queue one batch temp create while offline',
    ]);
    await act(async () => {
      await env.apiStore.performMutation(
        ['temp:Ada offline', 'temp:Linus offline'],
        {
          optimisticUpdate: () => {
            env.apiStore.addItemToState(
              'temp:Ada offline',
              { id: -1, name: 'Ada offline' },
              { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
            );
            env.apiStore.addItemToState(
              'temp:Linus offline',
              { id: -1, name: 'Linus offline' },
              { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
            );
          },
          mutation: async () => {
            const results = [
              { id: 3, name: 'Ada offline' },
              { id: 4, name: 'Linus offline' },
            ];
            for (const result of results) {
              await env.serverTable.delayedSetItem(
                `users||${result.id}`,
                result,
              );
            }
            return results;
          },
          offline: {
            operation: 'createUsers',
            input: [{ name: 'Ada offline' }, { name: 'Linus offline' }],
          },
        },
      );
    });

    // Edit each temp row before reconnecting. Replay should preserve this order
    // and retarget both edits to the final server ids from the batch create.
    env.addTimelineComments('beforeNextAction', [
      'edit both temp rows before reconnecting',
    ]);
    await act(async () => {
      await env.apiStore.performMutation('temp:Ada offline', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState(
            'temp:Ada offline',
            (item: { id: number; name: string }) => ({
              ...item,
              name: 'Ada rebound',
            }),
          );
        },
        mutation: async () => {
          await env.serverTable.delayedUpdateItem('temp:Ada offline', {
            name: 'Ada rebound',
          });
          return { name: 'Ada rebound' };
        },
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'temp:Ada offline', name: 'Ada rebound' },
        },
      });
      await env.apiStore.performMutation('temp:Linus offline', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState(
            'temp:Linus offline',
            (item: { id: number; name: string }) => ({
              ...item,
              name: 'Linus rebound',
            }),
          );
        },
        mutation: async () => {
          await env.serverTable.delayedUpdateItem('temp:Linus offline', {
            name: 'Linus rebound',
          });
          return { name: 'Linus rebound' };
        },
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'temp:Linus offline', name: 'Linus rebound' },
        },
      });
    });

    expect(
      getOfflineQueueEntries(sessionKey, storeName)
        .map((entry) => {
          const data = getOfflineQueueEntryData(entry);

          return { input: data.input, operation: String(data.operation) };
        })
        .sort((left, right) => {
          const operationOrder = left.operation.localeCompare(right.operation);
          if (operationOrder !== 0) return operationOrder;

          return JSON.stringify(left.input).localeCompare(
            JSON.stringify(right.input),
          );
        }),
    ).toMatchInlineSnapshot(`
      - input:
          - name: 'Ada offline'
          - name: 'Linus offline'
        operation: 'createUsers'
      - input: { itemId: 'temp:Ada offline', name: 'Ada rebound' }
        operation: 'patchUserName'
      - input: { itemId: 'temp:Linus offline', name: 'Linus rebound' }
        operation: 'patchUserName'
    `);

    // Reconnect and drain the queue. The batch create must reconcile both temp
    // ids before either queued edit is allowed to replay.
    env.addTimelineComments('beforeNextAction', [
      'go back online and replay the batch create plus both edits',
    ]);
    await act(async () => {
      network.goOnline();
      await Promise.resolve();
      await flushAllTimers();
      await Promise.resolve();
    });

    expect(replayedOperations).toMatchInlineSnapshot(`
      - input:
          - name: 'Ada offline'
          - name: 'Linus offline'
        operation: 'createUsers'
      - input: { itemId: 'users||3', name: 'Ada rebound' }
        operation: 'patchUserName'
      - input: { itemId: 'users||4', name: 'Linus rebound' }
        operation: 'patchUserName'
    `);
    expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`
      id: 3
      name: 'Ada rebound'
    `);
    expect(env.apiStore.getItemState('users||4')).toMatchInlineSnapshot(`
      id: 4
      name: 'Linus rebound'
    `);
    expect(env.apiStore.getItemState('temp:Ada offline')).toBeNull();
    expect(env.apiStore.getItemState('temp:Linus offline')).toBeNull();
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | batch-query-items                      |
      0     | Ada, Grace                             | [batch-query-items] ui-initialized
      3.01s | Ada, Grace                             | -- queue one batch temp create while offline
      .     | Ada, Grace, Ada offline, Linus offline | [batch-query-items] ui-changed
      .     | Ada, Grace, Ada offline, Linus offline | offline:createUsers queued
      .     | Ada, Grace, Ada offline, Linus offline | -- edit both temp rows before reconnecting
      .     | Ada, Grace, Ada rebound, Linus offline | [batch-query-items] ui-changed
      .     | Ada, Grace, Ada rebound, Linus offline | offline:patchUserName queued
      .     | Ada, Grace, Ada rebound, Linus rebound | [batch-query-items] ui-changed
      .     | Ada, Grace, Ada rebound, Linus rebound | offline:patchUserName queued
      .     | Ada, Grace, Ada rebound, Linus rebound | -- go back online and replay the batch create plus both edits
      .     | Ada, Grace, Ada rebound, Linus rebound | offline:createUsers replay-started
      4.21s | Ada, Grace, Ada rebound, Linus rebound | [users||3] server-data-changed (value: {"id":3,"name":"Ada offline"})
      5.41s | Ada, Grace, Ada rebound, Linus rebound | [users||4] server-data-changed (value: {"id":4,"name":"Linus offline"})
      .     | Ada, Grace, Ada rebound, Linus rebound | offline:createUsers replay-finished
      .     | Ada, Grace, Ada rebound, Linus rebound | [batch-query-items, batch-query-items, batch-query-items, batch-query-items] ui-changed
      .     | Ada, Grace, Ada rebound, Linus rebound | offline:patchUserName replay-started
      6.61s | Ada, Grace, Ada rebound, Linus rebound | [users||3] server-data-changed (value: {"name":"Ada rebound"})
      .     | Ada, Grace, Ada rebound, Linus rebound | offline:patchUserName replay-finished
      .     | Ada, Grace, Ada rebound, Linus rebound | offline:patchUserName replay-started
      7.81s | Ada, Grace, Ada rebound, Linus rebound | [users||4] server-data-changed (value: {"name":"Linus rebound"})
      .     | Ada, Grace, Ada rebound, Linus rebound | offline:patchUserName replay-finished
      7.82s | Ada, Grace, Ada rebound, Linus rebound | 🔴 >list-fetch-started
      8.62s | Ada, Grace, Ada rebound, Linus rebound | 🔴 <list-fetch-finished (value: {"count":4})
      "
    `);

    hook.unmount();
  });

  test('deleting a temp row while offline cancels the entire lifecycle without replaying', async () => {
    network.setOffline();
    const sessionKey = 'offline-replay-temp-create-then-delete-session';
    const storeName = 'offline-replay-temp-create-then-delete-store';
    const usersQuery = { tableId: 'users' } as const;
    const replayedOperations: Array<{
      operation: 'createUser' | 'patchUserName' | 'deleteUser';
      input:
        | { itemId: string; name: string }
        | { itemId: string }
        | { name: string };
    }> = [];

    type CreatePatchAndDeleteListQueryUserOperations =
      CreateListQueryUserOperations &
        PatchUserOperations & {
          deleteUser: ListQueryOfflineOperationDefinition<
            { id: number; name: string },
            ListQueryParams,
            string,
            { itemId: string },
            unknown
          >;
        };

    const env: ReturnType<
      typeof createListQueryStoreTestEnv<
        { id: number; name: string },
        false,
        false,
        CreatePatchAndDeleteListQueryUserOperations
      >
    > = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      CreatePatchAndDeleteListQueryUserOperations
    >(
      {
        users: [
          { id: 1, name: 'Ada' },
          { id: 2, name: 'Grace' },
        ],
      },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        storeManager: createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey: () => sessionKey,
          offlineSession: {
            network: network.config,
            classifyRetryableFailure: (error, ctx) =>
              classifyRetryableReplayFailure(error, ctx.phase),
          },
        }),
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            operations: {
              createUser: {
                inputSchema: collectionCreateInputSchema,
                kind: 'create',
                getEntityRefs: ({ input }) => [`temp:${input.name}`],
                tempEntity: {
                  buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                  reconcileServerEntity: (result) => ({
                    finalPayload: `users||${result.id}`,
                    finalData: result,
                  }),
                },
                execute: async ({ input }) => {
                  replayedOperations.push({ operation: 'createUser', input });
                  const result = { id: 3, name: input.name };
                  await env.serverTable.delayedSetItem('users||3', result);
                  return result;
                },
              },
              patchUserName: {
                inputSchema: userPatchSchema,
                kind: 'update',
                getEntityRefs: ({ input }) => [input.itemId],
                execute: ({ input }) => {
                  replayedOperations.push({
                    operation: 'patchUserName',
                    input,
                  });
                  return env.serverTable
                    .delayedUpdateItem(input.itemId, { name: input.name })
                    .then(() => ({ name: input.name }));
                },
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateItemState(input.itemId, (item) => ({
                    ...item,
                    name: input.name,
                  }));
                },
              },
              deleteUser: {
                inputSchema: deleteItemInputSchema,
                kind: 'delete',
                getEntityRefs: ({ input }) => [input.itemId],
                supersedes: {
                  scope: 'same-entity',
                  dropSelfIfTempLifecycleCancelled: true,
                },
                execute: ({ input }) => {
                  replayedOperations.push({ operation: 'deleteUser', input });
                  return env.serverTable.delayedRemoveItem(input.itemId);
                },
                onSuccessExecute: ({ input }) => {
                  env.apiStore.deleteItemState(input.itemId);
                },
              },
            },
          },
        },
      },
    );

    const hook = renderHook(() => {
      const query = env.apiStore.useListQuery(usersQuery, {
        itemSelector: (item) => item.name,
      });

      env.trackItemUI('query-status', query.status);
      env.trackItemUI('query-items', query.items.join(', '));
      return query;
    });
    await flushAllTimers();

    // Start a temp create so the following operations target the optimistic row.
    env.addTimelineComments('beforeNextAction', [
      'queue the temp create that starts the offline lifecycle',
    ]);
    await act(async () => {
      await env.apiStore.performMutation('temp:Linus offline', {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            'temp:Linus offline',
            { id: -1, name: 'Linus offline' },
            { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
          );
        },
        mutation: async () => {
          const result = { id: 3, name: 'Linus offline' };
          await env.serverTable.delayedSetItem('users||3', result);
          return result;
        },
        offline: { operation: 'createUser', input: { name: 'Linus offline' } },
      });
    });

    // Queue a temp-row edit that should also be pruned once delete cancels the lifecycle.
    env.addTimelineComments('beforeNextAction', [
      'queue an edit for the same temp row',
    ]);
    await act(async () => {
      await env.apiStore.performMutation('temp:Linus offline', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('temp:Linus offline', (item) => ({
            ...item,
            name: 'Linus edited',
          }));
        },
        mutation: async () => {
          await env.serverTable.delayedUpdateItem('temp:Linus offline', {
            name: 'Linus edited',
          });
          return { name: 'Linus edited' };
        },
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'temp:Linus offline', name: 'Linus edited' },
        },
      });
    });

    // Deleting the temp row should cancel the whole temp lifecycle and drop itself.
    env.addTimelineComments('beforeNextAction', [
      'delete the temp row so the full lifecycle gets cancelled',
    ]);
    await act(async () => {
      await env.apiStore.performMutation('temp:Linus offline', {
        optimisticUpdate: () => {
          env.apiStore.deleteItemState('temp:Linus offline');
        },
        mutation: () => env.serverTable.delayedRemoveItem('temp:Linus offline'),
        offline: {
          operation: 'deleteUser',
          input: { itemId: 'temp:Linus offline' },
        },
      });
    });

    expect(hook.result.current.items).toMatchInlineSnapshot(`
      ['Ada', 'Grace']
    `);
    expect(env.apiStore.getItemState('temp:Linus offline')).toBeNull();
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );

    // Reconnecting later should not replay anything, because the temp-create
    // lifecycle was fully cancelled while the app was still offline.
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();
    env.addTimelineComments('afterLastAction', [
      'go back online after the temp lifecycle was already cancelled',
    ]);

    expect(replayedOperations).toMatchInlineSnapshot(`[]`);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | query-items               | query-status |
      0     | Ada, Grace                | success      | [query-status, query-items] ui-initialized
      3.01s | Ada, Grace                | success      | -- queue the temp create that starts the offline lifecycle
      .     | Ada, Grace, Linus offline | success      | [query-items] ui-changed
      .     | Ada, Grace, Linus offline | success      | offline:createUser queued
      .     | Ada, Grace, Linus offline | success      | -- queue an edit for the same temp row
      .     | Ada, Grace, Linus edited  | success      | [query-items] ui-changed
      .     | Ada, Grace, Linus edited  | success      | offline:patchUserName queued
      .     | Ada, Grace, Linus edited  | success      | -- delete the temp row so the full lifecycle gets cancelled
      .     | Ada, Grace                | success      | [query-items] ui-changed
      .     | Ada, Grace                | success      | offline:deleteUser queued
      3.02s | Ada, Grace                | success      | 🔴 >list-fetch-started
      3.82s | Ada, Grace                | success      | 🔴 <list-fetch-finished (value: {"count":2})
      .     | Ada, Grace                | success      | -- go back online after the temp lifecycle was already cancelled
      "
    `);

    hook.unmount();
  });

  test('temp creates keep manually inserted query items visible after replay', async () => {
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
        storeManager: createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey: () => 'offline-replay-temp-list-query-session',
          offlineSession: {
            network: network.config,
            classifyRetryableFailure: (error, ctx) =>
              classifyRetryableReplayFailure(error, ctx.phase),
          },
        }),
        testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            operations: {
              createUser: {
                inputSchema: collectionCreateInputSchema,
                kind: 'create',
                getEntityRefs: ({ input }) => [`temp:${input.name}`],
                tempEntity: {
                  buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                  reconcileServerEntity: (result) => ({
                    finalPayload: `users||${result.id}`,
                    finalData: result,
                  }),
                },
                execute: async ({ input }) => {
                  const result = { id: nextUserId, name: input.name };
                  nextUserId += 1;
                  await env.serverTable.delayedSetItem(
                    `users||${result.id}`,
                    result,
                  );
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

    // Queue a temp create while offline — the item should appear in the query
    // immediately and remain visible after replay reconciles it.
    env.addTimelineComments('beforeNextAction', [
      'queue a temp create while offline',
    ]);
    await act(async () => {
      await env.apiStore.performMutation('temp:Linus offline', {
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
        mutation: async () => {
          const result = { id: 3, name: 'Linus offline' };
          await env.serverTable.delayedSetItem('users||3', result);
          return result;
        },
        offline: { operation: 'createUser', input: { name: 'Linus offline' } },
      });
    });

    expect(hook.result.current.items).toMatchInlineSnapshot(`
      ['Ada', 'Grace', 'Linus offline']
    `);

    // The temp entity is tracked as pending while offline
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
      - blockedByResolutionIds: []
        blockedResolutionCount: 0
        childResolutionCount: 0
        childResolutionIds: []
        createdAt: 1735689603010
        entityKey: '"temp:Linus offline'
        entityKind: 'item'
        id: 'offline-replay-temp-list-query-session:list-query-1:"temp:Linus offline'
        kind: 'create'
        pendingMutations: 1
        requiresResolution: '❌'
        sessionKey: 'offline-replay-temp-list-query-session'
        storeName: 'list-query-1'
        storeType: 'listQuery'
        syncState: 'pending'
        tempId: 'temp:Linus offline'
        updatedAt: 1735689603010
    `);

    // Go online and replay — the item should remain visible under its
    // reconciled server id and the query membership must be preserved.
    env.addTimelineComments('beforeNextAction', [
      'go online and replay the temp create',
    ]);
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    expect(hook.result.current.items).toMatchInlineSnapshot(`
      ['Ada', 'Grace', 'Linus offline']
    `);
    // Item is now stored under the reconciled server payload
    expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`
      id: 3
      name: 'Linus offline'
    `);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    // The only list request is the revalidation that follows the replay. It
    // starts after the temp row was reconciled (see the timeline below: the
    // row never leaves the list), so the membership is preserved by the
    // reconciliation itself, not by this refetch.
    expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'list'
          payload:
            fields: '*'
            pos: { limit: 50, offset: 0 }
          returned_items: 3
      `);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | query-items               | query-status |
      0     | Ada, Grace                | success      | [query-status, query-items] ui-initialized
      3.01s | Ada, Grace                | success      | -- queue a temp create while offline
      .     | Ada, Grace, Linus offline | success      | [query-items] ui-changed
      .     | Ada, Grace, Linus offline | success      | offline:createUser queued
      .     | Ada, Grace, Linus offline | success      | -- go online and replay the temp create
      .     | Ada, Grace, Linus offline | success      | offline:createUser replay-started
      4.21s | Ada, Grace, Linus offline | success      | [users||3] server-data-changed (value: {"id":3,"name":"Linus offline"})
      .     | Ada, Grace, Linus offline | success      | offline:createUser replay-finished
      .     | Ada, Grace, Linus offline | success      | [query-items, query-items] ui-changed
      4.22s | Ada, Grace, Linus offline | success      | 🔴 >list-fetch-started
      5.02s | Ada, Grace, Linus offline | success      | 🔴 <list-fetch-finished (value: {"count":3})
      "
    `);

    hook.unmount();
  });
});

describe('an edit of a row created offline that is not queued yet when the creation is saved', () => {
  /**
   * A users list where Linus was created offline under a temp id and the
   * creation is still queued. Renaming a user is a cell edit that waits 1.5s
   * for more typing before it is saved.
   */
  async function setupQueuedTempCreate(args: {
    sessionKey: string;
    storeName: string;
  }) {
    const usersQuery = { tableId: 'users' } as const;
    const replayedOperations: Array<{
      operation: 'createUser' | 'patchUserName';
      input: { itemId: string; name: string } | { name: string };
    }> = [];
    // The ids the renames sent directly (not replayed) were sent for
    const directRenames: Array<{ itemId: string; name: string }> = [];
    // The ids the `onSuccess` of the renames was called with
    const onSuccessPayloads: unknown[] = [];
    // The app checks the connection with a ping. A latency pushed here is
    // used by the next check, the other checks answer right away.
    const connectionCheckLatencies: number[] = [];

    const env: ReturnType<
      typeof createListQueryStoreTestEnv<
        { id: number; name: string },
        false,
        false,
        CreateAndPatchListQueryUserOperations
      >
    > = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      CreateAndPatchListQueryUserOperations
    >(
      {
        users: [
          { id: 1, name: 'Ada' },
          { id: 2, name: 'Grace' },
        ],
      },
      {
        id: args.storeName,
        getSessionKey: () => args.sessionKey,
        storeManager: createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey: () => args.sessionKey,
          offlineSession: {
            network: {
              enabled: true,
              getIsOffline: () => {
                const latency = connectionCheckLatencies.shift();
                if (latency === undefined) return network.isOffline();
                return new Promise((resolve) => {
                  setTimeout(() => resolve(network.isOffline()), latency);
                });
              },
            },
            classifyRetryableFailure: (error, ctx) =>
              classifyRetryableReplayFailure(error, ctx.phase),
          },
        }),
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            operations: {
              createUser: {
                inputSchema: collectionCreateInputSchema,
                kind: 'create',
                getEntityRefs: ({ input }) => [`temp:${input.name}`],
                tempEntity: {
                  buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                  reconcileServerEntity: (result) => ({
                    finalPayload: `users||${result.id}`,
                    finalData: result,
                  }),
                },
                execute: async ({ input }) => {
                  replayedOperations.push({ operation: 'createUser', input });
                  const result = { id: 3, name: input.name };
                  await env.serverTable.delayedSetItem('users||3', result);
                  return result;
                },
              },
              patchUserName: {
                inputSchema: userPatchSchema,
                kind: 'update',
                getEntityRefs: ({ input }) => [input.itemId],
                execute: async ({ input }) => {
                  replayedOperations.push({
                    operation: 'patchUserName',
                    input,
                  });
                  await env.serverTable.delayedUpdateItem(input.itemId, {
                    name: input.name,
                  });
                  return { name: input.name };
                },
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateItemState(
                    input.itemId,
                    (item: { id: number; name: string }) => ({
                      ...item,
                      name: input.name,
                    }),
                  );
                },
              },
            },
          },
        },
      },
    );

    const hook = renderHook(() => {
      const query = env.apiStore.useListQuery(usersQuery, {
        itemSelector: (item: { id: number; name: string }) => item.name,
      });

      env.trackItemUI('query-items', query.items.join(', '));
      return query;
    });
    await flushAllTimers();

    env.addTimelineComments('beforeNextAction', ['create Linus offline']);
    await act(async () => {
      await env.apiStore.performMutation('temp:Linus', {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            'temp:Linus',
            { id: -1, name: 'Linus' },
            { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
          );
        },
        mutation: () => Promise.reject(new Error('never sent directly')),
        offline: { operation: 'createUser', input: { name: 'Linus' } },
      });
    });

    // The results of the renames, in the order they settled
    const renameResults: unknown[] = [];

    /** Renames Linus in its cell, with the temp id the cell was rendered with */
    function renameLinus(name: string) {
      act(() => {
        void env.apiStore
          .performMutation('temp:Linus', {
            debounce: {
              context: 'rename-user',
              payload: 'temp:Linus',
              ms: 1500,
            },
            optimisticUpdate: () => {
              env.apiStore.updateItemState(
                'temp:Linus',
                (item: { id: number; name: string }) => ({ ...item, name }),
              );
            },
            // Applies the saved name to the row it is called with
            onSuccess: (_data, itemId) => {
              onSuccessPayloads.push(itemId);
              if (typeof itemId !== 'string') return;
              env.apiStore.updateItemState(
                itemId,
                (item: { id: number; name: string }) => ({ ...item, name }),
              );
            },
            // Sends the rename for the row it is called with
            mutation: async (itemId) => {
              if (typeof itemId !== 'string') throw new Error('expected an id');
              directRenames.push({ itemId, name });
              await new Promise((resolve) => {
                setTimeout(resolve, 1200);
              });
              // Fails when the connection dropped while it was sent
              if (network.isOffline()) throw new Error('Failed to fetch');
              env.serverTable.updateItem(itemId, { name });
              return { name };
            },
            offline: {
              operation: 'patchUserName',
              input: { itemId: 'temp:Linus', name },
            },
          })
          .then((result) => {
            renameResults.push(result.ok ? result.value : result.error);
          });
      });
    }

    return {
      env,
      hook,
      replayedOperations,
      directRenames,
      onSuccessPayloads,
      renameResults,
      renameLinus,
      connectionCheckLatencies,
    };
  }

  test('a rename whose debounce ends after the creation is saved is sent for the saved user', async () => {
    network.setOffline();
    const sessionKey = 'temp-edit-debounced-online-session';
    const storeName = 'temp-edit-debounced-online-store';
    const {
      env,
      hook,
      replayedOperations,
      directRenames,
      onSuccessPayloads,
      renameResults,
      renameLinus,
    } = await setupQueuedTempCreate({ sessionKey, storeName });

    // The user reconnects and renames Linus right away: the creation is sent
    // (1.2s) and saved while the rename still waits for its debounce (1.5s)
    env.addTimelineComments('beforeNextAction', [
      'rename Linus and reconnect: Linus is saved during the debounce',
    ]);
    renameLinus('Linus edited');
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // Nothing is left to replay, so the rename is sent directly, and for the
    // saved user instead of the temp id the server does not know
    expect(renameResults).toMatchInlineSnapshot(`
      - data: { name: 'Linus edited' }
        kind: 'online'
    `);
    expect(directRenames).toMatchInlineSnapshot(`
      - { itemId: 'users||3', name: 'Linus edited' }
    `);
    // `onSuccess` gets the saved user too, so the name it applies shows
    expect(onSuccessPayloads).toMatchInlineSnapshot(`['users||3']`);
    expect(replayedOperations).toMatchInlineSnapshot(`
      - input: { name: 'Linus' }
        operation: 'createUser'
    `);
    expect(env.serverTable.get('users||3')).toMatchInlineSnapshot(`
      id: 3
      name: 'Linus edited'
    `);
    expect(hook.result.current.items).toMatchInlineSnapshot(
      `['Ada', 'Grace', 'Linus edited']`,
    );
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    // Known gap: the saved user's data replaces the temp row, which hides the
    // rename still waiting for its debounce until the rename is saved
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | query-items              |
      0     | Ada, Grace               | [query-items] ui-initialized
      3.01s | Ada, Grace               | -- create Linus offline
      .     | Ada, Grace, Linus        | [query-items] ui-changed
      .     | Ada, Grace, Linus        | offline:createUser queued
      .     | Ada, Grace, Linus        | -- rename Linus and reconnect: Linus is saved during the debounce
      .     | Ada, Grace, Linus edited | [query-items] ui-changed
      .     | Ada, Grace, Linus edited | offline:createUser replay-started
      4.21s | Ada, Grace, Linus edited | [users||3] server-data-changed (value: {"id":3,"name":"Linus"})
      .     | Ada, Grace, Linus edited | offline:createUser replay-finished
      .     | Ada, Grace, Linus        | [query-items, query-items] ui-changed
      5.71s | Ada, Grace, Linus        | [users||3] server-data-changed (value: {"name":"Linus edited"})
      .     | Ada, Grace, Linus edited | [query-items] ui-changed
      5.72s | Ada, Grace, Linus edited | 🔴 >list-fetch-started
      6.52s | Ada, Grace, Linus edited | 🔴 <list-fetch-finished (value: {"count":3})
      "
    `);

    hook.unmount();
  });

  test('a rename whose debounce ends after the creation is saved and the connection dropped again is queued for the saved user', async () => {
    network.setOffline();
    const sessionKey = 'temp-edit-debounced-queued-session';
    const storeName = 'temp-edit-debounced-queued-store';
    const {
      env,
      hook,
      replayedOperations,
      directRenames,
      renameResults,
      renameLinus,
    } = await setupQueuedTempCreate({ sessionKey, storeName });

    // The user reconnects and renames Linus right away. The creation is saved
    // during the debounce, then the connection drops before the debounce ends
    env.addTimelineComments('beforeNextAction', [
      'rename Linus and reconnect: Linus is saved during the debounce',
    ]);
    renameLinus('Linus edited');
    act(() => {
      network.goOnline();
    });
    await advanceTime(1300);
    expect(env.serverTable.get('users||3')).toMatchInlineSnapshot(`
      id: 3
      name: 'Linus'
    `);
    env.addTimelineComments('beforeNextAction', [
      'the connection drops before the debounce ends',
    ]);
    act(() => {
      network.goOffline();
    });
    await advanceTime(500);

    // The rename is queued, for the saved user
    expect(renameResults).toMatchInlineSnapshot(`
      - kind: 'queued'
    `);
    expect(
      getOfflineQueueEntries(sessionKey, storeName).map((entry) =>
        pick(getOfflineQueueEntryData(entry), ['operation', 'input']),
      ),
    ).toMatchInlineSnapshot(`
      - input: { itemId: 'users||3', name: 'Linus edited' }
        operation: 'patchUserName'
    `);

    // Once back online, the queued rename is replayed and saved
    env.addTimelineComments('beforeNextAction', ['reconnect']);
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    expect(directRenames).toMatchInlineSnapshot(`[]`);
    expect(replayedOperations).toMatchInlineSnapshot(`
      - input: { name: 'Linus' }
        operation: 'createUser'
      - input: { itemId: 'users||3', name: 'Linus edited' }
        operation: 'patchUserName'
    `);
    expect(env.serverTable.get('users||3')).toMatchInlineSnapshot(`
      id: 3
      name: 'Linus edited'
    `);
    expect(hook.result.current.items).toMatchInlineSnapshot(
      `['Ada', 'Grace', 'Linus edited']`,
    );
    // Nothing was left for the user to resolve
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
    // Known gap: the saved user's data replaces the temp row, which hides the
    // rename still waiting for its debounce until the rename is replayed
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | query-items              |
      0     | Ada, Grace               | [query-items] ui-initialized
      3.01s | Ada, Grace               | -- create Linus offline
      .     | Ada, Grace, Linus        | [query-items] ui-changed
      .     | Ada, Grace, Linus        | offline:createUser queued
      .     | Ada, Grace, Linus        | -- rename Linus and reconnect: Linus is saved during the debounce
      .     | Ada, Grace, Linus edited | [query-items] ui-changed
      .     | Ada, Grace, Linus edited | offline:createUser replay-started
      4.21s | Ada, Grace, Linus edited | [users||3] server-data-changed (value: {"id":3,"name":"Linus"})
      .     | Ada, Grace, Linus edited | offline:createUser replay-finished
      .     | Ada, Grace, Linus        | [query-items, query-items] ui-changed
      4.51s | Ada, Grace, Linus        | -- the connection drops before the debounce ends
      .     | Ada, Grace, Linus        | offline:patchUserName queued
      4.81s | Ada, Grace, Linus        | -- reconnect
      .     | Ada, Grace, Linus        | offline:patchUserName replay-started
      6.01s | Ada, Grace, Linus        | [users||3] server-data-changed (value: {"name":"Linus edited"})
      .     | Ada, Grace, Linus        | offline:patchUserName replay-finished
      .     | Ada, Grace, Linus edited | [query-items] ui-changed
      6.02s | Ada, Grace, Linus edited | 🔴 >list-fetch-started
      6.82s | Ada, Grace, Linus edited | 🔴 <list-fetch-finished (value: {"count":3})
      "
    `);

    hook.unmount();
  });

  test('a rename whose connection check ends after the creation is saved is sent for the saved user, and queued for it when the request fails', async () => {
    network.setOffline();
    const sessionKey = 'temp-edit-connection-check-session';
    const storeName = 'temp-edit-connection-check-store';
    const {
      env,
      hook,
      replayedOperations,
      directRenames,
      renameResults,
      renameLinus,
      connectionCheckLatencies,
    } = await setupQueuedTempCreate({ sessionKey, storeName });

    // Still offline, the user renames Linus. The rename's debounce ends 1s
    // after reconnecting, while the creation (1.2s) is still being sent
    env.addTimelineComments('beforeNextAction', ['rename Linus offline']);
    renameLinus('Linus edited');
    await advanceTime(500);
    env.addTimelineComments('beforeNextAction', ['reconnect']);
    act(() => {
      network.goOnline();
    });
    await advanceTime(900);
    // The rename's connection check, when its debounce ends, takes 300ms:
    // Linus is saved while it runs
    connectionCheckLatencies.push(300);
    await advanceTime(400);
    expect(env.serverTable.get('users||3')).toMatchInlineSnapshot(`
      id: 3
      name: 'Linus'
    `);

    // The rename was sent for the saved user
    expect(directRenames).toMatchInlineSnapshot(`
      - { itemId: 'users||3', name: 'Linus edited' }
    `);

    // The connection drops while the rename is sent, so its request fails
    // and the rename is queued, for the saved user too
    env.addTimelineComments('beforeNextAction', [
      'the connection dropped while the rename was sent: its request failed',
    ]);
    act(() => {
      network.goOffline();
    });
    await advanceTime(1200);
    expect(renameResults).toMatchInlineSnapshot(`- kind: 'queued'`);
    expect(
      getOfflineQueueEntries(sessionKey, storeName).map((entry) =>
        pick(getOfflineQueueEntryData(entry), ['operation', 'input']),
      ),
    ).toMatchInlineSnapshot(`
      - input: { itemId: 'users||3', name: 'Linus edited' }
        operation: 'patchUserName'
    `);

    // Once back online, the queued rename is replayed and saved
    env.addTimelineComments('beforeNextAction', ['reconnect']);
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    expect(replayedOperations).toMatchInlineSnapshot(`
      - input: { name: 'Linus' }
        operation: 'createUser'
      - input: { itemId: 'users||3', name: 'Linus edited' }
        operation: 'patchUserName'
    `);
    expect(env.serverTable.get('users||3')).toMatchInlineSnapshot(`
      id: 3
      name: 'Linus edited'
    `);
    expect(hook.result.current.items).toMatchInlineSnapshot(
      `['Ada', 'Grace', 'Linus edited']`,
    );
    // Nothing was left for the user to resolve
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    // Known gap: the saved user's data replaces the temp row, which hides the
    // rename not queued yet until the rename is replayed
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | query-items              |
      0     | Ada, Grace               | [query-items] ui-initialized
      3.01s | Ada, Grace               | -- create Linus offline
      .     | Ada, Grace, Linus        | [query-items] ui-changed
      .     | Ada, Grace, Linus        | offline:createUser queued
      .     | Ada, Grace, Linus        | -- rename Linus offline
      .     | Ada, Grace, Linus edited | [query-items] ui-changed
      3.51s | Ada, Grace, Linus edited | -- reconnect
      .     | Ada, Grace, Linus edited | offline:createUser replay-started
      4.71s | Ada, Grace, Linus edited | [users||3] server-data-changed (value: {"id":3,"name":"Linus"})
      .     | Ada, Grace, Linus edited | offline:createUser replay-finished
      .     | Ada, Grace, Linus        | [query-items, query-items] ui-changed
      6.01s | Ada, Grace, Linus        | -- the connection dropped while the rename was sent: its request failed
      .     | Ada, Grace, Linus        | offline:patchUserName queued
      .     | Ada, Grace, Linus        | -- reconnect
      .     | Ada, Grace, Linus        | offline:patchUserName replay-started
      6.02s | Ada, Grace, Linus        | 🔴 >list-fetch-started
      6.82s | Ada, Grace, Linus        | 🔴 <list-fetch-finished (value: {"count":3})
      7.21s | Ada, Grace, Linus        | [users||3] server-data-changed (value: {"name":"Linus edited"})
      .     | Ada, Grace, Linus        | offline:patchUserName replay-finished
      .     | Ada, Grace, Linus edited | [query-items] ui-changed
      7.22s | Ada, Grace, Linus edited | 🟠 >list-fetch-started
      8.02s | Ada, Grace, Linus edited | 🟠 <list-fetch-finished (value: {"count":3})
      "
    `);

    hook.unmount();
  });
});
