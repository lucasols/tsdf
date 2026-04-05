import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_array, rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ListQueryOfflineOperationDefinition } from '../../src/main';
import { createOfflineSession } from '../../src/main';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import {
  type CreateListQueryUserOperations,
  deleteItemInputSchema,
  getOfflineQueueEntries,
  getOfflineQueueEntryData,
  type PatchUserOperations,
  replayBatchListQueryCreateWithDelay,
  replayListQueryCreateWithDelay,
  replayListQueryDeleteWithDelay,
  replayListQueryPatchWithDelay,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  collectionCreateInputSchema,
  listQueryQueryPayloadSchema,
  summarizeResolution,
  waitForMicrotaskCondition,
} from './offlineTestShared';

let network = createOfflineNetworkMock();

type CreateAndPatchListQueryUserOperations = CreateListQueryUserOperations &
  PatchUserOperations;
type NestedListQueryUserRow = { id: number; name: string; parentId?: string };
type CreateChildListQueryUserOperations = {
  createChildUser: ListQueryOfflineOperationDefinition<
    NestedListQueryUserRow,
    ListQueryParams,
    string,
    { name: string; parentId: string },
    unknown,
    NestedListQueryUserRow
  >;
};
type PatchNestedListQueryUserOperations = {
  patchUserName: ListQueryOfflineOperationDefinition<
    NestedListQueryUserRow,
    ListQueryParams,
    string,
    { itemId: string; name: string },
    unknown
  >;
};
type NestedTempCreateListQueryUserOperations = CreateListQueryUserOperations &
  CreateChildListQueryUserOperations &
  PatchNestedListQueryUserOperations;

const nestedUserRowSchema = rc_object({
  id: rc_number,
  name: rc_string,
  parentId: rc_string.optionalKey(),
});
const nestedChildCreateInputSchema = rc_object({
  name: rc_string,
  parentId: rc_string,
});

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
      ({ input: _input_ }: { input: { itemId: string; name: string } }) => {
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
                onSuccessExecute: null,
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
    expect(hook.result.current.items).toMatchInlineSnapshot(`['Ada pending']`);
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
      env.apiStore.getOfflineResolutions().map(summarizeResolution),
    ).toMatchInlineSnapshot(
      `
        - error: 'replay execute failed'
          input: 'itemId: "users||1", name: "Ada replayed"'
          kind: 'retry-exhausted'
          on: 'item:users||1'
          op: 'patchUserName'
      `,
    );
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | query-items | query-status |
      0      | Ada         | success      | [query-status, query-items] ui-initialized
      3.01s  | Ada         | success      | -- queue an offline edit for the existing row
      .      | Ada pending | success      | [query-items] ui-changed
      .      | Ada pending | success      | offline:patchUserName queued
      .      | Ada pending | success      | -- go back online and let replay retries exhaust
      .      | Ada pending | success      | offline:patchUserName replay-started
      8.01s  | Ada pending | success      | offline:patchUserName replay-started
      13.01s | Ada pending | success      | offline:patchUserName replay-started
      18.01s | Ada pending | success      | offline:patchUserName replay-started
      23.01s | Ada pending | success      | offline:patchUserName replay-started
      .      | Ada pending | success      | offline:patchUserName resolution-required
      "
    `);

    hook.unmount();
  });

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
                execute: async ({ input }) => {
                  replayedOperations.push({ operation: 'createUser', input });
                  const result = { id: nextUserId, name: input.name };
                  nextUserId += 1;
                  const replayResult = replayListQueryCreateWithDelay(
                    env,
                    result,
                  );

                  return replayResult;
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
                  const replayResult = replayListQueryPatchWithDelay(
                    env,
                    input,
                  );

                  return replayResult;
                },
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateItemState(input.itemId, (item) => ({
                    ...item,
                    name: input.name,
                  }));
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
      4.21s | Ada, Grace, Linus edited  | success      | [users||3] server-data-changed (value: {"id":3,"name":"Linus offline"})
      .     | Ada, Grace, Linus edited  | success      | offline:createUser replay-finished
      .     | Ada, Grace, Linus offline | success      | [query-items, query-items] ui-changed
      .     | Ada, Grace, Linus offline | success      | offline:patchUserName replay-started
      5.41s | Ada, Grace, Linus offline | success      | [users||3] server-data-changed (value: {"name":"Linus edited"})
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
                execute: async ({ input }) => {
                  replayedOperations.push({ operation: 'createUsers', input });
                  const results = input.map((item) => {
                    const result = { id: nextUserId, name: item.name };
                    nextUserId += 1;
                    return result;
                  });
                  const replayResult = replayBatchListQueryCreateWithDelay(
                    env,
                    results,
                  );

                  return replayResult;
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
                  const replayResult = replayListQueryPatchWithDelay(
                    env,
                    input,
                  );

                  return replayResult;
                },
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateItemState(input.itemId, (item) => ({
                    ...item,
                    name: input.name,
                  }));
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
      .     | Ada, Grace, Ada offline, Linus offline | [batch-query-items, batch-query-items, batch-query-items] ui-changed
      .     | Ada, Grace, Ada offline, Linus offline | offline:patchUserName replay-started
      6.61s | Ada, Grace, Ada offline, Linus offline | [users||3] server-data-changed (value: {"name":"Ada rebound"})
      .     | Ada, Grace, Ada offline, Linus offline | offline:patchUserName replay-finished
      .     | Ada, Grace, Ada rebound, Linus offline | [batch-query-items] ui-changed
      .     | Ada, Grace, Ada rebound, Linus offline | offline:patchUserName replay-started
      7.81s | Ada, Grace, Ada rebound, Linus offline | [users||4] server-data-changed (value: {"name":"Linus rebound"})
      .     | Ada, Grace, Ada rebound, Linus offline | offline:patchUserName replay-finished
      .     | Ada, Grace, Ada rebound, Linus rebound | [batch-query-items] ui-changed
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
                execute: async ({ input }) => {
                  replayedOperations.push({ operation: 'createUser', input });
                  return replayListQueryCreateWithDelay(env, {
                    id: 3,
                    name: input.name,
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
                  const replayResult = replayListQueryPatchWithDelay(
                    env,
                    input,
                  );

                  return replayResult;
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
                getEntityRefs: ({ input }) => [input.itemId],
                supersedes: {
                  scope: 'same-entity',
                  dropSelfIfTempLifecycleCancelled: true,
                },
                execute: ({ input }) => {
                  replayedOperations.push({ operation: 'deleteUser', input });
                  const replayResult = replayListQueryDeleteWithDelay(
                    env,
                    input,
                  );

                  return replayResult;
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

  test('nested temp-create descendants cascade into manual resolutions and discard together', async () => {
    network.setOffline();
    const usersQuery = { tableId: 'users' } as const;
    const createUserExecute = vi
      .fn<
        ({
          input,
        }: {
          input: { name: string };
        }) => Promise<{ id: number; name: string }>
      >()
      .mockRejectedValueOnce(new Error('create replay failed'))
      .mockRejectedValueOnce(new Error('create replay failed'))
      .mockRejectedValueOnce(new Error('create replay failed'))
      .mockRejectedValueOnce(new Error('create replay failed'))
      .mockRejectedValueOnce(new Error('create replay failed'));
    const createChildUserExecute = vi
      .fn<
        ({
          input,
        }: {
          input: { name: string; parentId: string };
        }) => Promise<NestedListQueryUserRow>
      >()
      .mockImplementation(async () => {
        const result = { id: 4, name: 'Child offline', parentId: 'users||3' };
        await env.serverTable.delayedSetItem('users||4', result);
        return result;
      });
    const patchUserExecute = vi.fn(
      ({ input }: { input: { itemId: string; name: string } }) => {
        const replayResult = replayListQueryPatchWithDelay(env, input);

        return replayResult;
      },
    );

    const env = createListQueryStoreTestEnv<
      NestedListQueryUserRow,
      false,
      false,
      NestedTempCreateListQueryUserOperations
    >(
      {
        users: [
          { id: 1, name: 'Ada' },
          { id: 2, name: 'Grace' },
        ],
      },
      {
        id: 'offline-replay-nested-temp-create-chain-store',
        getSessionKey: () => 'offline-replay-nested-temp-create-chain-session',
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: nestedUserRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () =>
                'offline-replay-nested-temp-create-chain-session',
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
                execute: createUserExecute,
              },
              createChildUser: {
                inputSchema: nestedChildCreateInputSchema,
                getEntityRefs: ({ input }) => [`temp:${input.name}`],
                dependsOn: ({ input }) => [input.parentId],
                tempEntity: {
                  buildPendingEntity: (input) => ({
                    id: -2,
                    name: input.name,
                    parentId: input.parentId,
                  }),
                  reconcileServerEntity: (result) => ({
                    finalPayload: `users||${result.id}`,
                    finalData: result,
                  }),
                },
                execute: createChildUserExecute,
              },
              patchUserName: {
                inputSchema: userPatchSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: patchUserExecute,
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateItemState(input.itemId, (item) => ({
                    ...item,
                    name: input.name,
                  }));
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

      env.trackItemUI('query-items', query.items.join(', '));
      return query;
    });
    await flushAllTimers();

    // Queue the root parent temp create while offline.
    env.addTimelineComments('beforeNextAction', [
      'queue the root parent temp create',
    ]);
    await act(async () => {
      await env.apiStore.performMutation(null, {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            'temp:Parent offline',
            { id: -1, name: 'Parent offline' },
            { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
          );
        },
        mutation: () => Promise.resolve({ id: 3, name: 'Parent offline' }),
        offline: { operation: 'createUser', input: { name: 'Parent offline' } },
      });
    });

    // Queue a nested child temp create that depends on the parent's temp id.
    env.addTimelineComments('beforeNextAction', [
      'queue a nested child temp create depending on the parent',
    ]);
    await act(async () => {
      await env.apiStore.performMutation(null, {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            'temp:Child offline',
            { id: -2, name: 'Child offline', parentId: 'temp:Parent offline' },
            { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
          );
        },
        mutation: () =>
          Promise.resolve({
            id: 4,
            name: 'Child offline',
            parentId: 'users||3',
          }),
        offline: {
          operation: 'createChildUser',
          input: { name: 'Child offline', parentId: 'temp:Parent offline' },
        },
      });
    });

    // Queue a grandchild edit against the child temp item so the cascade has to
    // recurse beyond the direct child resolution.
    env.addTimelineComments('beforeNextAction', [
      'queue an edit against the child temp item',
    ]);
    await act(async () => {
      await env.apiStore.performMutation('temp:Child offline', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('temp:Child offline', (item) => ({
            ...item,
            name: 'Child blocked edit',
          }));
        },
        mutation: () => Promise.resolve({ name: 'Child blocked edit' }),
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'temp:Child offline', name: 'Child blocked edit' },
        },
      });
    });

    // Exhaust the parent replay. The nested child temp-create and the edit that
    // depends on that child should both become blocked manual resolutions.
    env.addTimelineComments('beforeNextAction', [
      'go online and exhaust parent replay to trigger cascading resolutions',
    ]);
    await act(async () => {
      network.goOnline();
      await Promise.resolve();
    });
    await waitForMicrotaskCondition(
      () => createUserExecute.mock.calls.length === 1,
    );
    for (const attempt of [2, 3, 4, 5]) {
      await advanceTime(5_000);
      await waitForMicrotaskCondition(
        () => createUserExecute.mock.calls.length === attempt,
      );
    }
    await flushAllTimers();

    const parentResolution = env.apiStore
      .getOfflineResolutions()
      .find((resolution) => resolution.operation === 'createUser');
    const childCreateResolution = env.apiStore
      .getOfflineResolutions()
      .find((resolution) => resolution.operation === 'createChildUser');
    const grandchildResolution = env.apiStore
      .getOfflineResolutions()
      .find((resolution) => resolution.operation === 'patchUserName');

    expect(parentResolution).toBeDefined();
    expect(childCreateResolution).toBeDefined();
    expect(grandchildResolution).toBeDefined();
    if (!parentResolution || !childCreateResolution || !grandchildResolution) {
      throw new Error('Expected the full nested temp-create resolution chain');
    }

    // Neither the child create nor the grandchild edit should have been attempted
    // — they are blocked by the parent's failed replay.
    expect(createChildUserExecute).not.toHaveBeenCalled();
    expect(patchUserExecute).not.toHaveBeenCalled();

    // Verify the parent → child → grandchild resolution chain is wired correctly
    expect(parentResolution.childResolutionIds[0]).toBe(
      childCreateResolution.id,
    );
    expect(summarizeResolution(parentResolution)).toMatchInlineSnapshot(
      `
        blocks: 1
        error: 'create replay failed'
        input: 'name: "Parent offline"'
        kind: 'retry-exhausted'
        on: 'item:temp:Parent offline'
        op: 'createUser'
        tempIds: ['temp:Parent offline']
      `,
    );
    expect(childCreateResolution.blockedByResolutionIds[0]).toBe(
      parentResolution.id,
    );
    expect(childCreateResolution.childResolutionIds[0]).toBe(
      grandchildResolution.id,
    );
    expect(summarizeResolution(childCreateResolution)).toMatchInlineSnapshot(
      `
        blockedBy: 1
        blocks: 1
        error: 'Blocked by unresolved dependency'
        input: 'name: "Child offline", parentId: "temp:Parent offline"'
        kind: 'retry-exhausted'
        on: 'item:temp:Child offline'
        op: 'createChildUser'
        tempIds: ['temp:Child offline']
      `,
    );
    expect(grandchildResolution.blockedByResolutionIds[0]).toBe(
      childCreateResolution.id,
    );
    expect(summarizeResolution(grandchildResolution)).toMatchInlineSnapshot(
      `
        blockedBy: 1
        error: 'Blocked by unresolved dependency'
        input: 'itemId: "temp:Child offline", name: "Child blocked edit"'
        kind: 'retry-exhausted'
        on: 'item:temp:Child offline'
        op: 'patchUserName'
      `,
    );
    const parentEntity = env.apiStore
      .getOfflineEntities()
      .find(
        (entity) =>
          entity.entityKey ===
          env.getStoreItemKeyFromRaw('temp:Parent offline'),
      );
    const childEntity = env.apiStore
      .getOfflineEntities()
      .find(
        (entity) =>
          entity.entityKey === env.getStoreItemKeyFromRaw('temp:Child offline'),
      );

    // Verify entity → resolution cross-references
    expect(parentEntity?.childResolutionIds[0]).toBe(childCreateResolution.id);
    expect(
      pick(parentEntity, [
        'blockedResolutionCount',
        'childResolutionCount',
        'createdAt',
        'entityKey',
        'entityKind',
        'id',
        'pendingMutations',
        'requiresResolution',
        'sessionKey',
        'storeName',
        'storeType',
        'syncState',
        'tempId',
        'updatedAt',
      ]),
    ).toMatchInlineSnapshot(`
      blockedResolutionCount: 0
      childResolutionCount: 1
      createdAt: 1735689623010
      entityKey: '"temp:Parent offline'
      entityKind: 'item'
      id: 'offline-replay-nested-temp-create-chain-session:offline-replay-nested-temp-create-chain-store:"temp:Parent offline'
      pendingMutations: 0
      requiresResolution: '✅'
      sessionKey: 'offline-replay-nested-temp-create-chain-session'
      storeName: 'offline-replay-nested-temp-create-chain-store'
      storeType: 'listQuery'
      syncState: 'resolution-required'
      tempId: 'temp:Parent offline'
      updatedAt: 1735689623010
    `);
    // Child entity is blocked by both the parent and the child-create resolutions
    expect(childEntity?.blockedByResolutionIds).toEqual(
      expect.arrayContaining([parentResolution.id, childCreateResolution.id]),
    );
    expect(childEntity?.childResolutionIds[0]).toBe(grandchildResolution.id);

    // Discarding the parent should clear every nested descendant and roll back
    // both optimistic temp items from the query and item state.
    env.addTimelineComments('beforeNextAction', [
      'discard the parent to cascade-clear all descendants',
    ]);
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        parentResolution.id,
        'createUser',
        { action: 'discard' },
      );
      await Promise.resolve();
    });
    await flushAllTimers();

    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getItemState('temp:Parent offline')).toBeNull();
    expect(env.apiStore.getItemState('temp:Child offline')).toBeNull();
    expect(hook.result.current.items).toMatchInlineSnapshot(`
      ['Ada', 'Grace']
    `);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | query-items                                    |
      0      | Ada, Grace                                     | ui-initialized
      3.01s  | Ada, Grace                                     | -- queue the root parent temp create
      .      | Ada, Grace, Parent offline                     | ui-changed
      .      | Ada, Grace, Parent offline                     | offline:createUser queued
      .      | Ada, Grace, Parent offline                     | -- queue a nested child temp create depending on the parent
      .      | Ada, Grace, Parent offline, Child offline      | ui-changed
      .      | Ada, Grace, Parent offline, Child offline      | offline:createChildUser queued
      .      | Ada, Grace, Parent offline, Child offline      | -- queue an edit against the child temp item
      .      | Ada, Grace, Parent offline, Child blocked edit | ui-changed
      .      | Ada, Grace, Parent offline, Child blocked edit | offline:patchUserName queued
      .      | Ada, Grace, Parent offline, Child blocked edit | -- go online and exhaust parent replay to trigger cascading resolutions
      .      | Ada, Grace, Parent offline, Child blocked edit | offline:createUser replay-started
      8.01s  | Ada, Grace, Parent offline, Child blocked edit | offline:createUser replay-started
      13.01s | Ada, Grace, Parent offline, Child blocked edit | offline:createUser replay-started
      18.01s | Ada, Grace, Parent offline, Child blocked edit | offline:createUser replay-started
      23.01s | Ada, Grace, Parent offline, Child blocked edit | offline:createUser replay-started
      .      | Ada, Grace, Parent offline, Child blocked edit | offline:createChildUser resolution-required
      .      | Ada, Grace, Parent offline, Child blocked edit | offline:createUser resolution-required
      .      | Ada, Grace, Parent offline, Child blocked edit | offline:patchUserName resolution-required
      .      | Ada, Grace, Parent offline, Child blocked edit | -- discard the parent to cascade-clear all descendants
      .      | Ada, Grace                                     | ui-changed
      "
    `);

    hook.unmount();
  });

  test('temp-create retry exhaustion promotes dependent edits into blocked resolutions that unblock after the parent succeeds', async () => {
    network.setOffline();
    const usersQuery = { tableId: 'users' } as const;
    const createUserExecute = vi
      .fn<
        ({
          input,
        }: {
          input: { name: string };
        }) => Promise<{ id: number; name: string }>
      >()
      .mockRejectedValueOnce(new Error('create replay failed'))
      .mockRejectedValueOnce(new Error('create replay failed'))
      .mockRejectedValueOnce(new Error('create replay failed'))
      .mockRejectedValueOnce(new Error('create replay failed'))
      .mockRejectedValueOnce(new Error('create replay failed'))
      .mockImplementationOnce(async ({ input }: { input: { name: string } }) =>
        replayListQueryCreateWithDelay(env, { id: 3, name: input.name }),
      );
    const patchUserExecute = vi.fn(
      ({ input }: { input: { itemId: string; name: string } }) => {
        const replayResult = replayListQueryPatchWithDelay(env, input);

        return replayResult;
      },
    );

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
        id: 'offline-replay-temp-create-resolution-chain-store',
        getSessionKey: () =>
          'offline-replay-temp-create-resolution-chain-session',
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () =>
                'offline-replay-temp-create-resolution-chain-session',
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
                execute: createUserExecute,
              },
              patchUserName: {
                inputSchema: userPatchSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: patchUserExecute,
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateItemState(input.itemId, (item) => ({
                    ...item,
                    name: input.name,
                  }));
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

      env.trackItemUI('query-items', query.items.join(', '));
      env.trackItemUI('query-status', query.status);
      return query;
    });
    await flushAllTimers();

    // Queue the temp create while offline so replay has to reconcile it later.
    env.addTimelineComments('beforeNextAction', [
      'queue the temp create and a dependent edit while offline',
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

    await act(async () => {
      await env.apiStore.performMutation('temp:Linus offline', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('temp:Linus offline', (item) => ({
            ...item,
            name: 'Linus blocked edit',
          }));
        },
        mutation: () => Promise.resolve({ name: 'Linus blocked edit' }),
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'temp:Linus offline', name: 'Linus blocked edit' },
        },
      });
    });

    // Replay the temp create until it reaches manual resolution; its dependent
    // edit should be promoted into a blocked manual resolution at the same time.
    env.addTimelineComments('beforeNextAction', [
      'go online and let the temp create exhaust replay retries',
    ]);
    act(() => {
      network.goOnline();
    });
    await waitForMicrotaskCondition(
      () => createUserExecute.mock.calls.length === 1,
    );
    for (const attempt of [2, 3, 4, 5]) {
      await advanceTime(5_000);
      await waitForMicrotaskCondition(
        () => createUserExecute.mock.calls.length === attempt,
      );
    }
    await flushAllTimers();

    const parentResolution = env.apiStore
      .getOfflineResolutions()
      .find((resolution) => resolution.operation === 'createUser');
    const childResolution = env.apiStore
      .getOfflineResolutions()
      .find((resolution) => resolution.operation === 'patchUserName');

    expect(parentResolution).toBeDefined();
    expect(childResolution).toBeDefined();
    if (!parentResolution || !childResolution) {
      throw new Error('Expected temp-create parent and child resolutions');
    }

    // Verify parent → child resolution cross-references
    expect(parentResolution.childResolutionIds[0]).toBe(childResolution.id);
    expect(summarizeResolution(parentResolution)).toMatchInlineSnapshot(
      `
        blocks: 1
        error: 'create replay failed'
        input: 'name: "Linus offline"'
        kind: 'retry-exhausted'
        on: 'item:temp:Linus offline'
        op: 'createUser'
        tempIds: ['temp:Linus offline']
      `,
    );
    expect(childResolution.blockedByResolutionIds[0]).toBe(parentResolution.id);
    expect(summarizeResolution(childResolution)).toMatchInlineSnapshot(
      `
        blockedBy: 1
        error: 'Blocked by unresolved dependency'
        input: 'itemId: "temp:Linus offline", name: "Linus blocked edit"'
        kind: 'retry-exhausted'
        on: 'item:temp:Linus offline'
        op: 'patchUserName'
      `,
    );
    // Verify the temp entity's resolution cross-references
    const [tempEntity] = env.apiStore.getOfflineEntities();
    expect(tempEntity?.blockedByResolutionIds[0]).toBe(parentResolution.id);
    expect(tempEntity?.childResolutionIds[0]).toBe(childResolution.id);
    expect(
      pick(tempEntity, [
        'blockedResolutionCount',
        'childResolutionCount',
        'createdAt',
        'entityKey',
        'entityKind',
        'id',
        'pendingMutations',
        'requiresResolution',
        'sessionKey',
        'storeName',
        'storeType',
        'syncState',
        'tempId',
        'updatedAt',
      ]),
    ).toMatchInlineSnapshot(`
      blockedResolutionCount: 1
      childResolutionCount: 1
      createdAt: 1735689623010
      entityKey: '"temp:Linus offline'
      entityKind: 'item'
      id: 'offline-replay-temp-create-resolution-chain-session:offline-replay-temp-create-resolution-chain-store:"temp:Linus offline'
      pendingMutations: 0
      requiresResolution: '✅'
      sessionKey: 'offline-replay-temp-create-resolution-chain-session'
      storeName: 'offline-replay-temp-create-resolution-chain-store'
      storeType: 'listQuery'
      syncState: 'resolution-required'
      tempId: 'temp:Linus offline'
      updatedAt: 1735689623010
    `);
    expect(patchUserExecute).not.toHaveBeenCalled();

    // The blocked child must not become independently resolvable before the
    // parent temp create has either succeeded or been discarded.
    await expect(
      env.apiStore.resolveOfflineResolution(
        childResolution.id,
        'patchUserName',
        { action: 'retry' },
      ),
    ).rejects.toThrow(
      'Cannot resolve a blocked offline resolution before its blocking dependencies are cleared',
    );

    // Retrying the parent should reconcile the temp payload to a real id and
    // leave the child manual resolution unblocked and remapped.
    env.addTimelineComments('beforeNextAction', [
      'retry the parent resolution so the temp payload can reconcile',
    ]);
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        parentResolution.id,
        'createUser',
        { action: 'retry' },
      );
      await Promise.resolve();
    });
    await waitForMicrotaskCondition(
      () => createUserExecute.mock.calls.length === 6,
    );
    await flushAllTimers();

    const remappedChildResolution = env.apiStore
      .getOfflineResolutions()
      .find((resolution) => resolution.operation === 'patchUserName');
    expect(env.apiStore.getOfflineResolutions()).toHaveLength(1);

    expect(summarizeResolution(remappedChildResolution!)).toMatchInlineSnapshot(
      `
        error: 'Blocked by unresolved dependency'
        input: 'itemId: "users||3", name: "Linus blocked edit"'
        kind: 'retry-exhausted'
        on: 'item:users||3'
        op: 'patchUserName'
      `,
    );

    // Once the child is remapped onto the final payload, it becomes eligible for
    // retry and should apply cleanly against the server-backed item.
    env.addTimelineComments('beforeNextAction', [
      'retry the remapped child resolution',
    ]);
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        remappedChildResolution!.id,
        'patchUserName',
        { action: 'retry' },
      );
      await Promise.resolve();
    });
    await waitForMicrotaskCondition(
      () => patchUserExecute.mock.calls.length === 1,
    );
    await flushAllTimers();

    expect(patchUserExecute.mock.calls.map(([ctx]) => ctx.input))
      .toMatchInlineSnapshot(`
        - { itemId: 'users||3', name: 'Linus blocked edit' }
      `);
    expect(hook.result.current.items).toMatchInlineSnapshot(`
      ['Ada', 'Grace', 'Linus blocked edit']
    `);
    expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`
      id: 3
      name: 'Linus blocked edit'
    `);
    expect(env.apiStore.getItemState('temp:Linus offline')).toBeNull();
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | query-items                    | query-status |
      0      | Ada, Grace                     | success      | [query-items, query-status] ui-initialized
      3.01s  | Ada, Grace                     | success      | -- queue the temp create and a dependent edit while offline
      .      | Ada, Grace, Linus offline      | success      | [query-items] ui-changed
      .      | Ada, Grace, Linus offline      | success      | offline:createUser queued
      .      | Ada, Grace, Linus blocked edit | success      | [query-items] ui-changed
      .      | Ada, Grace, Linus blocked edit | success      | offline:patchUserName queued
      .      | Ada, Grace, Linus blocked edit | success      | -- go online and let the temp create exhaust replay retries
      .      | Ada, Grace, Linus blocked edit | success      | offline:createUser replay-started
      8.01s  | Ada, Grace, Linus blocked edit | success      | offline:createUser replay-started
      13.01s | Ada, Grace, Linus blocked edit | success      | offline:createUser replay-started
      18.01s | Ada, Grace, Linus blocked edit | success      | offline:createUser replay-started
      23.01s | Ada, Grace, Linus blocked edit | success      | offline:createUser replay-started
      .      | Ada, Grace, Linus blocked edit | success      | offline:createUser resolution-required
      .      | Ada, Grace, Linus blocked edit | success      | offline:patchUserName resolution-required
      .      | Ada, Grace, Linus blocked edit | success      | -- retry the parent resolution so the temp payload can reconcile
      .      | Ada, Grace, Linus blocked edit | success      | offline:createUser replay-started
      24.21s | Ada, Grace, Linus blocked edit | success      | [users||3] server-data-changed (value: {"id":3,"name":"Linus offline"})
      .      | Ada, Grace, Linus blocked edit | success      | offline:createUser replay-finished
      .      | Ada, Grace, Linus offline      | success      | [query-items] ui-changed
      25.21s | Ada, Grace, Linus offline      | success      | -- retry the remapped child resolution
      .      | Ada, Grace, Linus offline      | success      | offline:patchUserName replay-started
      26.41s | Ada, Grace, Linus offline      | success      | [users||3] server-data-changed (value: {"name":"Linus blocked edit"})
      .      | Ada, Grace, Linus offline      | success      | offline:patchUserName replay-finished
      .      | Ada, Grace, Linus blocked edit | success      | [query-items] ui-changed
      "
    `);

    hook.unmount();
  });

  test('discarding a temp-create parent resolution removes dependent descendants and clears the temp chain', async () => {
    network.setOffline();
    const usersQuery = { tableId: 'users' } as const;
    const createUserExecute = vi
      .fn<
        ({
          input,
        }: {
          input: { name: string };
        }) => Promise<{ id: number; name: string }>
      >()
      .mockRejectedValueOnce(new Error('create replay failed'))
      .mockRejectedValueOnce(new Error('create replay failed'))
      .mockRejectedValueOnce(new Error('create replay failed'))
      .mockRejectedValueOnce(new Error('create replay failed'))
      .mockRejectedValueOnce(new Error('create replay failed'));

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
        id: 'offline-replay-temp-create-discard-store',
        getSessionKey: () => 'offline-replay-temp-create-discard-session',
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => 'offline-replay-temp-create-discard-session',
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
                execute: createUserExecute,
              },
              patchUserName: {
                inputSchema: userPatchSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: ({ input }) => {
                  const replayResult = replayListQueryPatchWithDelay(
                    env,
                    input,
                  );

                  return replayResult;
                },
                onSuccessExecute: null,
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

      env.trackItemUI('query-items', query.items.join(', '));
      return query;
    });
    await flushAllTimers();

    // Queue a temp create and a dependent edit so both become manual resolutions
    // after the parent's replay is exhausted.
    env.addTimelineComments('beforeNextAction', [
      'queue a temp create and a dependent edit while offline',
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

    // Queue a dependent edit against the same temp row
    await act(async () => {
      await env.apiStore.performMutation('temp:Linus offline', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('temp:Linus offline', (item) => ({
            ...item,
            name: 'Linus discarded edit',
          }));
        },
        mutation: () => Promise.resolve({ name: 'Linus discarded edit' }),
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'temp:Linus offline', name: 'Linus discarded edit' },
        },
      });
    });

    // Exhaust the parent replay so both parent and child become manual
    // resolutions rooted at the same temp entity.
    env.addTimelineComments('beforeNextAction', [
      'go online and let the parent temp create exhaust replay',
    ]);
    act(() => {
      network.goOnline();
    });
    await waitForMicrotaskCondition(
      () => createUserExecute.mock.calls.length === 1,
    );
    for (const attempt of [2, 3, 4, 5]) {
      await advanceTime(5_000);
      await waitForMicrotaskCondition(
        () => createUserExecute.mock.calls.length === attempt,
      );
    }
    await flushAllTimers();

    const parentResolution = env.apiStore
      .getOfflineResolutions()
      .find((resolution) => resolution.operation === 'createUser');
    if (!parentResolution) {
      throw new Error('Expected the temp-create parent resolution');
    }

    // Discarding the parent should remove the blocked child resolution and the
    // optimistic temp row in one cascade.
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        parentResolution.id,
        'createUser',
        { action: 'discard' },
      );
      await Promise.resolve();
    });
    await flushAllTimers();

    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getItemState('temp:Linus offline')).toBeNull();
    expect(hook.result.current.items).toMatchInlineSnapshot(`
      ['Ada', 'Grace']
    `);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | query-items                      |
      0      | Ada, Grace                       | ui-initialized
      3.01s  | Ada, Grace                       | -- queue a temp create and a dependent edit while offline
      .      | Ada, Grace, Linus offline        | ui-changed
      .      | Ada, Grace, Linus offline        | offline:createUser queued
      .      | Ada, Grace, Linus discarded edit | ui-changed
      .      | Ada, Grace, Linus discarded edit | offline:patchUserName queued
      .      | Ada, Grace, Linus discarded edit | -- go online and let the parent temp create exhaust replay
      .      | Ada, Grace, Linus discarded edit | offline:createUser replay-started
      8.01s  | Ada, Grace, Linus discarded edit | offline:createUser replay-started
      13.01s | Ada, Grace, Linus discarded edit | offline:createUser replay-started
      18.01s | Ada, Grace, Linus discarded edit | offline:createUser replay-started
      23.01s | Ada, Grace, Linus discarded edit | offline:createUser replay-started
      .      | Ada, Grace, Linus discarded edit | offline:createUser resolution-required
      .      | Ada, Grace, Linus discarded edit | offline:patchUserName resolution-required
      .      | Ada, Grace                       | ui-changed
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
                execute: async ({ input }) => {
                  const result = { id: nextUserId, name: input.name };
                  nextUserId += 1;
                  const replayResult = replayListQueryCreateWithDelay(
                    env,
                    result,
                  );

                  return replayResult;
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
      4.21s | Ada, Grace, Linus offline | success      | [users||3] server-data-changed (value: {"id":3,"name":"Linus offline"})
      .     | Ada, Grace, Linus offline | success      | offline:createUser replay-finished
      .     | Ada, Grace, Linus offline | success      | [query-items, query-items] ui-changed
      "
    `);

    hook.unmount();
  });
});
