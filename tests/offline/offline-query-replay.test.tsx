import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_array, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ListQueryOfflineOperationDefinition } from '../../src/main';
import { createOfflineSession } from '../../src/main';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import {
  type CreateListQueryUserOperations,
  deleteItemInputSchema,
  getOfflineQueueEntries,
  getOfflineQueueEntryData,
  type PatchUserOperations,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import {
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
  test('queued patch stays anchored to the original row when retries exhaust', async () => {
    network.setOffline();
    const sessionKey = 'offline-replay-mutation-payload-session';
    const storeName = 'offline-replay-mutation-payload-store';
    // Execute always throws so replay retries exhaust and the mutation
    // eventually promotes to a manual resolution.
    const execute = vi.fn(
      ({ input }: { input: { itemId: string; name: string } }) => {
        env.apiStore.updateItemState(input.itemId, (item) => ({
          ...item,
          name: input.name,
        }));

        throw new Error('replay execute failed');
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
        id: storeName,
        getSessionKey: () => sessionKey,
        testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => sessionKey,
              config: { network: network.config },
            }),
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

    // Queue an offline edit against an existing row so replay has to keep
    // targeting that exact payload even if it later needs manual resolution.
    env.addTimelineComments('beforeNextAction', [
      'queue an offline edit for the existing row',
    ]);
    await act(async () => {
      await env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('users||1', (item) => ({
            ...item,
            name: 'Ada pending',
          }));
        },
        mutation: () => Promise.resolve({ name: 'Ada replayed' }),
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Ada replayed' },
        },
      });
    });

    expect(hook.result.current.items).toMatchInlineSnapshot(`
      ['Ada pending']
    `);
    expect(
      env.apiStore
        .getOfflineEntities()
        .map(({ entityKey, pendingMutations, storeType, syncState }) => ({
          entityKey,
          pendingMutations,
          storeType,
          syncState,
        })),
    ).toMatchInlineSnapshot(`
      - entityKey: '"users||1'
        pendingMutations: 1
        storeType: 'listQuery'
        syncState: 'pending'
    `);
    expect(
      getOfflineQueueEntries(sessionKey, storeName).map((entry) => {
        const data = getOfflineQueueEntryData(entry);

        return {
          entityRefs: data.entityRefs,
          input: data.input,
          operation: data.operation,
          storeName: data.storeName,
          storeType: data.storeType,
          syncState: data.syncState,
        };
      }),
    ).toMatchInlineSnapshot(`
      - entityRefs:
          - entityKey: '"users||1'
            entityKind: 'item'
        input: { itemId: 'users||1', name: 'Ada replayed' }
        operation: 'patchUserName'
        storeName: 'offline-replay-mutation-payload-store'
        storeType: 'listQuery'
        syncState: 'pending'
    `);

    // Go back online and let replay exhaust. The queue entry should promote into
    // a manual resolution, but every replay attempt must stay anchored to users||1.
    env.addTimelineComments('beforeNextAction', [
      'go back online and let replay retries exhaust',
    ]);
    await act(async () => {
      network.goOnline();
      await Promise.resolve();
      await flushAllTimers();
      await Promise.resolve();
    });

    expect(execute).toHaveBeenCalled();
    // Every replay attempt must target the same row with the original input
    expect(execute.mock.calls[0]?.[0].input).toMatchInlineSnapshot(`
      itemId: 'users||1'
      name: 'Ada replayed'
    `);
    expect(
      execute.mock.calls.every(
        ([ctx]) =>
          ctx.input.itemId === 'users||1' && ctx.input.name === 'Ada replayed',
      ),
    ).toBe(true);
    expect(hook.result.current.items).toMatchInlineSnapshot(`['Ada replayed']`);
    expect(
      env.apiStore
        .getOfflineEntities()
        .map(({ entityKey, pendingMutations, storeType, syncState }) => ({
          entityKey,
          pendingMutations,
          storeType,
          syncState,
        })),
    ).toMatchInlineSnapshot(`
      - entityKey: '"users||1'
        pendingMutations: 0
        storeType: 'listQuery'
        syncState: 'resolution-required'
    `);
    expect(
      env.apiStore
        .getOfflineResolutions()
        .map((resolution) => ({
          ...pick(resolution, [
            'blockedResolutionCount',
            'childResolutionCount',
            'entityRefs',
            'input',
            'kind',
            'operation',
          ]),
          lastReplayError:
            resolution.kind === 'retry-exhausted'
              ? resolution.lastReplayError
              : null,
        })),
    ).toMatchInlineSnapshot(`
      - blockedResolutionCount: 0
        childResolutionCount: 0
        entityRefs:
          - entityKey: '"users||1'
            entityKind: 'item'
        input: { itemId: 'users||1', name: 'Ada replayed' }
        kind: 'retry-exhausted'
        lastReplayError: { message: 'replay execute failed' }
        operation: 'patchUserName'
    `);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | query-items  | query-status |
      0      | Ada          | success      | [query-status, query-items] ui-initialized
      3.01s  | Ada          | success      | -- queue an offline edit for the existing row
      .      | Ada pending  | success      | [query-items] ui-changed
      .      | Ada pending  | success      | offline:patchUserName queued
      .      | Ada pending  | success      | -- go back online and let replay retries exhaust
      .      | Ada pending  | success      | offline:patchUserName replay-started
      8.01s  | Ada pending  | success      | offline:patchUserName replay-started
      13.01s | Ada pending  | success      | offline:patchUserName replay-started
      18.01s | Ada pending  | success      | offline:patchUserName replay-started
      23.01s | Ada pending  | success      | offline:patchUserName replay-started
      .      | Ada pending  | success      | offline:patchUserName resolution-required
      .      | Ada replayed | success      | [query-items] ui-changed
      "
    `);

    hook.unmount();
  });

  type CreateAndPatchListQueryUserOperations = CreateListQueryUserOperations &
    PatchUserOperations;

  test('temp create replays before the queued edit and remaps it to the final server id', async () => {
    network.setOffline();
    const sessionKey = 'offline-replay-temp-create-then-edit-session';
    const storeName = 'offline-replay-temp-create-then-edit-store';
    const usersQuery = { tableId: 'users' } as const;
    let nextUserId = 3;
    const replayedOperations: Array<{
      operation: 'createUser' | 'patchUserName';
      input: { itemId: string; name: string } | { name: string };
    }> = [];

    const env = createListQueryStoreTestEnv<
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
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => sessionKey,
              config: { network: network.config },
            }),
            operations: {
              createUser: {
                inputSchema: collectionCreateInputSchema,
                getEntityRefs: ({ input }) => [`temp:${input.name}`],
                tempEntity: {
                  buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                  reconcileServerEntity: (result) => ({
                    finalPayload: `users||${result.id}`,
                    finalData: result,
                  }),
                },
                execute: ({ input }) => {
                  replayedOperations.push({ operation: 'createUser', input });
                  const result = { id: nextUserId, name: input.name };
                  nextUserId += 1;
                  return result;
                },
              },
              patchUserName: {
                inputSchema: userPatchSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: ({ input }) => {
                  replayedOperations.push({
                    operation: 'patchUserName',
                    input,
                  });
                  env.apiStore.updateItemState(input.itemId, (item) => ({
                    ...item,
                    name: input.name,
                  }));
                  return { name: input.name };
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

    // Queue an offline temp create so later mutations have to follow that
    // temporary payload until replay can reconcile it to a real server id.
    env.addTimelineComments('beforeNextAction', [
      'queue a temp create while offline',
    ]);
    await act(async () => {
      await env.apiStore.performMutation(null, {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            'temp:Linus offline',
            { id: -1, name: 'Linus offline' },
            { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
          );
        },
        mutation: () => Promise.resolve({ id: 3, name: 'Linus offline' }),
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
          env.apiStore.updateItemState('temp:Linus offline', (item) => ({
            ...item,
            name: 'Linus edited',
          }));
        },
        mutation: () => Promise.resolve({ name: 'Linus edited' }),
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'temp:Linus offline', name: 'Linus edited' },
        },
      });
    });

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
      time  | query-items               | query-status |
      0     | Ada, Grace                | success      | [query-status, query-items] ui-initialized
      3.01s | Ada, Grace                | success      | -- queue a temp create while offline
      .     | Ada, Grace, Linus offline | success      | [query-items] ui-changed
      .     | Ada, Grace, Linus offline | success      | offline:createUser queued
      .     | Ada, Grace, Linus offline | success      | -- edit the same temp row before reconnecting
      .     | Ada, Grace, Linus edited  | success      | [query-items] ui-changed
      .     | Ada, Grace, Linus edited  | success      | offline:patchUserName queued
      .     | Ada, Grace, Linus edited  | success      | -- go back online and replay both queued mutations
      .     | Ada, Grace, Linus edited  | success      | offline:createUser replay-started
      .     | Ada, Grace, Linus edited  | success      | offline:createUser replay-finished
      .     | Ada, Grace, Linus offline | success      | [query-items, query-items] ui-changed
      .     | Ada, Grace, Linus offline | success      | offline:patchUserName replay-started
      .     | Ada, Grace, Linus offline | success      | offline:patchUserName replay-finished
      .     | Ada, Grace, Linus edited  | success      | [query-items] ui-changed
      "
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

    const env = createListQueryStoreTestEnv<
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
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => sessionKey,
              config: { network: network.config },
            }),
            operations: {
              createUsers: {
                inputSchema: batchCreateUserInputSchema,
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
                execute: ({ input }) => {
                  replayedOperations.push({ operation: 'createUsers', input });
                  return input.map((item) => {
                    const result = { id: nextUserId, name: item.name };
                    nextUserId += 1;
                    return result;
                  });
                },
              },
              patchUserName: {
                inputSchema: userPatchSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: ({ input }) => {
                  replayedOperations.push({
                    operation: 'patchUserName',
                    input,
                  });
                  env.apiStore.updateItemState(input.itemId, (item) => ({
                    ...item,
                    name: input.name,
                  }));
                  return { name: input.name };
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
      await env.apiStore.performMutation(null, {
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
        mutation: () => Promise.resolve([]),
        offline: {
          operation: 'createUsers',
          input: [{ name: 'Ada offline' }, { name: 'Linus offline' }],
        },
      });
    });

    // Edit each temp row before reconnecting. Replay should preserve this order
    // and retarget both edits to the final server ids from the batch create.
    env.addTimelineComments('beforeNextAction', [
      'edit both temp rows before reconnecting',
    ]);
    await act(async () => {
      await env.apiStore.performMutation('temp:Ada offline', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('temp:Ada offline', (item) => ({
            ...item,
            name: 'Ada rebound',
          }));
        },
        mutation: () => Promise.resolve({ name: 'Ada rebound' }),
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'temp:Ada offline', name: 'Ada rebound' },
        },
      });
      await env.apiStore.performMutation('temp:Linus offline', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('temp:Linus offline', (item) => ({
            ...item,
            name: 'Linus rebound',
          }));
        },
        mutation: () => Promise.resolve({ name: 'Linus rebound' }),
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
      time  | batch-query-items                                                  |
      0     | Ada, Grace                                                         | ui-initialized
      3.01s | Ada, Grace                                                         | -- queue one batch temp create while offline
      .     | Ada, Grace, Ada offline, Linus offline                             | ui-changed
      .     | Ada, Grace, Ada offline, Linus offline                             | offline:createUsers queued
      .     | Ada, Grace, Ada offline, Linus offline                             | -- edit both temp rows before reconnecting
      .     | Ada, Grace, Ada rebound, Linus offline                             | ui-changed
      .     | Ada, Grace, Ada rebound, Linus offline                             | offline:patchUserName queued
      .     | Ada, Grace, Ada rebound, Linus rebound                             | ui-changed
      .     | Ada, Grace, Ada rebound, Linus rebound                             | offline:patchUserName queued
      .     | Ada, Grace, Ada rebound, Linus rebound                             | -- go back online and replay the batch create plus both edits
      .     | Ada, Grace, Ada rebound, Linus rebound                             | offline:createUsers replay-started
      .     | Ada, Grace, Ada rebound, Linus rebound                             | offline:createUsers replay-finished
      .     | Ada, Grace, Ada rebound, Ada offline, Linus rebound                | ui-changed
      .     | Ada, Grace, Ada rebound, Linus rebound, Ada offline, Linus offline | ui-changed
      .     | Ada, Grace, Ada offline, Linus offline                             | ui-changed
      .     | Ada, Grace, Ada offline, Linus offline                             | offline:patchUserName replay-started
      .     | Ada, Grace, Ada offline, Linus offline                             | offline:patchUserName replay-finished
      .     | Ada, Grace, Ada rebound, Linus offline                             | ui-changed
      .     | Ada, Grace, Ada rebound, Linus offline                             | offline:patchUserName replay-started
      .     | Ada, Grace, Ada rebound, Linus offline                             | offline:patchUserName replay-finished
      .     | Ada, Grace, Ada rebound, Linus rebound                             | ui-changed
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

    const env = createListQueryStoreTestEnv<
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
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => sessionKey,
              config: { network: network.config },
            }),
            operations: {
              createUser: {
                inputSchema: collectionCreateInputSchema,
                getEntityRefs: ({ input }) => [`temp:${input.name}`],
                tempEntity: {
                  buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                  reconcileServerEntity: (result) => ({
                    finalPayload: `users||${result.id}`,
                    finalData: result,
                  }),
                },
                execute: ({ input }) => {
                  replayedOperations.push({ operation: 'createUser', input });
                  return { id: 3, name: input.name };
                },
              },
              patchUserName: {
                inputSchema: userPatchSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: ({ input }) => {
                  replayedOperations.push({
                    operation: 'patchUserName',
                    input,
                  });
                  env.apiStore.updateItemState(input.itemId, (item) => ({
                    ...item,
                    name: input.name,
                  }));
                  return { name: input.name };
                },
              },
              deleteUser: {
                inputSchema: deleteItemInputSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                supersedes: {
                  scope: 'same-entity',
                  dropSelfIfTempLifecycleCancelled: true,
                },
                execute: ({ input }) => {
                  replayedOperations.push({ operation: 'deleteUser', input });
                  env.apiStore.deleteItemState(input.itemId);
                  return undefined;
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
      await env.apiStore.performMutation(null, {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            'temp:Linus offline',
            { id: -1, name: 'Linus offline' },
            { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
          );
        },
        mutation: () => Promise.resolve({ id: 3, name: 'Linus offline' }),
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
        mutation: () => Promise.resolve({ name: 'Linus edited' }),
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
        mutation: () => Promise.resolve(undefined),
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
        testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => 'offline-replay-temp-list-query-session',
              config: { network: network.config },
            }),
            operations: {
              createUser: {
                inputSchema: collectionCreateInputSchema,
                getEntityRefs: ({ input }) => [`temp:${input.name}`],
                tempEntity: {
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

    // Queue a temp create while offline — the item should appear in the query
    // immediately and remain visible after replay reconciles it.
    env.addTimelineComments('beforeNextAction', [
      'queue a temp create while offline',
    ]);
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
    expect(
      env.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | query-items               | query-status |
      0     | Ada, Grace                | success      | [query-status, query-items] ui-initialized
      3.01s | Ada, Grace                | success      | -- queue a temp create while offline
      .     | Ada, Grace, Linus offline | success      | [query-items] ui-changed
      .     | Ada, Grace, Linus offline | success      | offline:createUser queued
      .     | Ada, Grace, Linus offline | success      | -- go online and replay the temp create
      .     | Ada, Grace, Linus offline | success      | offline:createUser replay-started
      .     | Ada, Grace, Linus offline | success      | offline:createUser replay-finished
      .     | Ada, Grace, Linus offline | success      | [query-items, query-items] ui-changed
      "
    `);

    hook.unmount();
  });
});
