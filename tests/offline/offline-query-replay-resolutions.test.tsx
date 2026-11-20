import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ListQueryOfflineOperationDefinition } from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import {
  type CreateListQueryUserOperations,
  deleteItemInputSchema,
  getLocalStorageKeys,
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
  summarizeResolution,
  waitForMicrotaskCondition,
} from './offlineTestShared';

let network = createOfflineNetworkMock();

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

type NestedTempCreateListQueryUserOperations = CreateListQueryUserOperations &
  CreateChildListQueryUserOperations &
  PatchNestedListQueryUserOperations;

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
        storeManager: createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey: () => sessionKey,
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
              patchUserName: {
                inputSchema: userPatchSchema,
                kind: 'update',
                getEntityRefs: ({ input }) => [input.itemId],
                execute,
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
        mutation: async () => {
          await env.serverTable.delayedUpdateItem('users||1', {
            name: 'Ada replayed',
          });
          return { name: 'Ada replayed' };
        },
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
      time | query-items | query-status |
      0    | Ada         | success      | [query-status, query-items] ui-initialized
      12s  | Ada         | success      | -- queue an offline edit for the existing row
      .    | Ada pending | success      | [query-items] ui-changed
      .    | Ada pending | success      | offline:patchUserName queued
      .    | Ada pending | success      | -- go back online and let replay retries exhaust
      .    | Ada pending | success      | offline:patchUserName replay-started
      17s  | Ada pending | success      | offline:patchUserName replay-started
      22s  | Ada pending | success      | offline:patchUserName replay-started
      .    | Ada pending | success      | offline:patchUserName resolution-required
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
      ({ input }: { input: { itemId: string; name: string } }) =>
        env.serverTable
          .delayedUpdateItem(input.itemId, { name: input.name })
          .then(() => ({ name: input.name })),
    );

    const env: ReturnType<
      typeof createListQueryStoreTestEnv<
        NestedListQueryUserRow,
        false,
        false,
        NestedTempCreateListQueryUserOperations
      >
    > = createListQueryStoreTestEnv<
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
        storeManager: createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey: () =>
            'offline-replay-nested-temp-create-chain-session',
          offlineSession: {
            network: network.config,
            classifyRetryableFailure: (error, ctx) =>
              classifyRetryableReplayFailure(error, ctx.phase),
          },
        }),
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: nestedUserRowSchema,
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
                execute: createUserExecute,
              },
              createChildUser: {
                inputSchema: nestedChildCreateInputSchema,
                kind: 'create',
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
                kind: 'update',
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
      await env.apiStore.performMutation('temp:Parent offline', {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            'temp:Parent offline',
            { id: -1, name: 'Parent offline' },
            { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
          );
        },
        mutation: async () => {
          const result = { id: 3, name: 'Parent offline' };
          await env.serverTable.delayedSetItem('users||3', result);
          return result;
        },
        offline: { operation: 'createUser', input: { name: 'Parent offline' } },
      });
    });

    // Queue a nested child temp create that depends on the parent's temp id.
    env.addTimelineComments('beforeNextAction', [
      'queue a nested child temp create depending on the parent',
    ]);
    await act(async () => {
      await env.apiStore.performMutation('temp:Child offline', {
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
        mutation: async () => {
          await env.serverTable.delayedUpdateItem('temp:Child offline', {
            name: 'Child blocked edit',
          });
          return { name: 'Child blocked edit' };
        },
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
    for (const attempt of [2, 3]) {
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
      createdAt: 1735689613010
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
      updatedAt: 1735689613010
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
      .      | Ada, Grace, Parent offline, Child blocked edit | offline:createChildUser resolution-required
      .      | Ada, Grace, Parent offline, Child blocked edit | offline:createUser resolution-required
      .      | Ada, Grace, Parent offline, Child blocked edit | offline:patchUserName resolution-required
      .      | Ada, Grace, Parent offline, Child blocked edit | -- discard the parent to cascade-clear all descendants
      .      | Ada, Grace                                     | ui-changed
      13.02s | Ada, Grace                                     | 🔴 >list-fetch-started
      13.82s | Ada, Grace                                     | 🔴 <list-fetch-finished (value: {"count":2})
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
      .mockImplementationOnce(
        async ({ input }: { input: { name: string } }) => {
          const result = { id: 3, name: input.name };
          await env.serverTable.delayedSetItem('users||3', result);
          return result;
        },
      );
    const patchUserExecute = vi.fn(
      ({ input }: { input: { itemId: string; name: string } }) =>
        env.serverTable
          .delayedUpdateItem(input.itemId, { name: input.name })
          .then(() => ({ name: input.name })),
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
        storeManager: createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey: () =>
            'offline-replay-temp-create-resolution-chain-session',
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
                execute: createUserExecute,
              },
              patchUserName: {
                inputSchema: userPatchSchema,
                kind: 'update',
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

    await act(async () => {
      await env.apiStore.performMutation('temp:Linus offline', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('temp:Linus offline', (item) => ({
            ...item,
            name: 'Linus blocked edit',
          }));
        },
        mutation: async () => {
          await env.serverTable.delayedUpdateItem('temp:Linus offline', {
            name: 'Linus blocked edit',
          });
          return { name: 'Linus blocked edit' };
        },
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
    for (const attempt of [2, 3]) {
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
      createdAt: 1735689613010
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
      updatedAt: 1735689613010
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
    // automatically replay the descendant against the remapped id.
    env.addTimelineComments('beforeNextAction', [
      'retry the parent resolution so the remapped descendant replays too',
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
      () => createUserExecute.mock.calls.length === 4,
    );
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
    expect(env.timelineString).not.toContain(
      'Linus offline      | success      | offline:patchUserName replay-started',
    );
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
      .      | Ada, Grace, Linus blocked edit | success      | offline:createUser resolution-required
      .      | Ada, Grace, Linus blocked edit | success      | offline:patchUserName resolution-required
      .      | Ada, Grace, Linus blocked edit | success      | -- retry the parent resolution so the remapped descendant replays too
      .      | Ada, Grace, Linus blocked edit | success      | offline:createUser replay-started
      14.21s | Ada, Grace, Linus blocked edit | success      | [users||3] server-data-changed (value: {"id":3,"name":"Linus offline"})
      .      | Ada, Grace, Linus blocked edit | success      | offline:createUser replay-finished
      .      | Ada, Grace, Linus blocked edit | success      | [query-items, query-items] ui-changed
      .      | Ada, Grace, Linus blocked edit | success      | offline:patchUserName replay-started
      15.41s | Ada, Grace, Linus blocked edit | success      | [users||3] server-data-changed (value: {"name":"Linus blocked edit"})
      .      | Ada, Grace, Linus blocked edit | success      | offline:patchUserName replay-finished
      15.42s | Ada, Grace, Linus blocked edit | success      | 🔴 >list-fetch-started
      16.22s | Ada, Grace, Linus blocked edit | success      | 🔴 <list-fetch-finished (value: {"count":3})
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
        storeManager: createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey: () => 'offline-replay-temp-create-discard-session',
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
                execute: createUserExecute,
              },
              patchUserName: {
                inputSchema: userPatchSchema,
                kind: 'update',
                getEntityRefs: ({ input }) => [input.itemId],
                execute: ({ input }) => {
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

    // Queue a dependent edit against the same temp row
    await act(async () => {
      await env.apiStore.performMutation('temp:Linus offline', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('temp:Linus offline', (item) => ({
            ...item,
            name: 'Linus discarded edit',
          }));
        },
        mutation: async () => {
          await env.serverTable.delayedUpdateItem('temp:Linus offline', {
            name: 'Linus discarded edit',
          });
          return { name: 'Linus discarded edit' };
        },
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
    for (const attempt of [2, 3]) {
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
      .      | Ada, Grace, Linus discarded edit | offline:createUser resolution-required
      .      | Ada, Grace, Linus discarded edit | offline:patchUserName resolution-required
      .      | Ada, Grace                       | ui-changed
      13.02s | Ada, Grace                       | 🔴 >list-fetch-started
      13.82s | Ada, Grace                       | 🔴 <list-fetch-finished (value: {"count":2})
      "
    `);

    hook.unmount();
  });
});

test('discarding failed offline changes puts the rows back to what the server has', async () => {
  network.setOffline();
  const sessionKey = 'offline-discard-restores-rows-session';
  type RejectedEditOperations = PatchUserOperations & {
    deleteUser: ListQueryOfflineOperationDefinition<
      { id: number; name: string },
      ListQueryParams,
      string,
      { itemId: string },
      unknown
    >;
  };

  // The server rejects both changes on every replay attempt, so they end up
  // waiting for the user to decide what to do with them.
  const env = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    RejectedEditOperations
  >(
    {
      users: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
    },
    {
      id: 'offline-discard-restores-rows-store',
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
      testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          operations: {
            patchUserName: {
              inputSchema: userPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: () => {
                throw new Error('rename rejected');
              },
              onSuccessExecute: () => {},
            },
            deleteUser: {
              inputSchema: deleteItemInputSchema,
              kind: 'delete',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: () => {
                throw new Error('delete rejected');
              },
              onSuccessExecute: () => {},
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

    env.trackItemUI('rows', query.items.join(', '));
    return query;
  });
  await flushAllTimers();

  // Offline: rename Ada and delete Grace, both applied optimistically.
  env.addTimelineComments('beforeNextAction', [
    'offline: rename Ada and delete Grace',
  ]);
  await act(async () => {
    await env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', (item) => ({
          ...item,
          name: 'Ada renamed',
        }));
      },
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada renamed' },
      },
    });
    await env.apiStore.performMutation('users||2', {
      optimisticUpdate: () => {
        env.apiStore.deleteItemState('users||2');
      },
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: { operation: 'deleteUser', input: { itemId: 'users||2' } },
    });
  });

  // Online: every replay attempt is rejected until both changes need a
  // manual resolution.
  env.addTimelineComments('beforeNextAction', [
    'back online: the server rejects both changes until they need a resolution',
  ]);
  act(() => {
    network.goOnline();
  });
  // 3 attempts per change, 5s apart: 30s covers both.
  await advanceTime(30_000);
  await flushAllTimers();

  const renameResolution = env.apiStore
    .getOfflineResolutions()
    .find((resolution) => resolution.operation === 'patchUserName');
  const deleteResolution = env.apiStore
    .getOfflineResolutions()
    .find((resolution) => resolution.operation === 'deleteUser');
  if (!renameResolution || !deleteResolution) {
    throw new Error('Expected both changes to be waiting for a resolution');
  }

  // Discard the rename. Nothing can roll the optimistic rename back, so the
  // store refetches what the discarded change touched. The lists are not
  // refetched yet: Grace's delete still waits for a decision, and refetched
  // lists would bring her back while the user still has to decide on her
  // delete. Only Ada's item would be refetched, and no screen shows it outside
  // of the list, so the row keeps the renamed value for now.
  env.addTimelineComments('beforeNextAction', [
    'discard the rename: no refetch while the delete waits for a decision',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      renameResolution.id,
      'patchUserName',
      { action: 'discard' },
    );
  });
  await flushAllTimers();

  // Grace is still hidden while her delete waits for a decision.
  expect(hook.result.current.items).toMatchInlineSnapshot(`['Ada renamed']`);

  // Discard the delete: with nothing left to resolve the store revalidates
  // its lists, which puts both rows back to what the server has. Grace, deleted
  // locally, is also fetched for screens that show only her.
  env.addTimelineComments('beforeNextAction', [
    'discard the delete: the lists are refetched and show the server rows',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      deleteResolution.id,
      'deleteUser',
      { action: 'discard' },
    );
  });
  await flushAllTimers();

  expect(hook.result.current.items).toMatchInlineSnapshot(`['Ada', 'Grace']`);
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | rows               |
    0      | Ada, Grace         | [rows] ui-initialized
    3.01s  | Ada, Grace         | -- offline: rename Ada and delete Grace
    .      | Ada renamed, Grace | [rows] ui-changed
    .      | Ada renamed, Grace | offline:patchUserName queued
    .      | Ada renamed        | [rows] ui-changed
    .      | Ada renamed        | offline:deleteUser queued
    .      | Ada renamed        | -- back online: the server rejects both changes until they need a resolution
    .      | Ada renamed        | offline:patchUserName replay-started
    8.01s  | Ada renamed        | offline:patchUserName replay-started
    13.01s | Ada renamed        | offline:patchUserName replay-started
    .      | Ada renamed        | offline:patchUserName resolution-required
    .      | Ada renamed        | offline:deleteUser replay-started
    18.01s | Ada renamed        | offline:deleteUser replay-started
    23.01s | Ada renamed        | offline:deleteUser replay-started
    .      | Ada renamed        | offline:deleteUser resolution-required
    34.02s | Ada renamed        | -- discard the rename: no refetch while the delete waits for a decision
    .      | Ada renamed        | -- discard the delete: the lists are refetched and show the server rows
    .      | Ada renamed        | 🔴 >list-fetch-started
    .      | Ada renamed        | 🟠 [users||2] >fetch-started
    34.82s | Ada renamed        | 🔴 <list-fetch-finished (value: {"count":2})
    .      | Ada, Grace         | [rows] ui-changed
    .      | Ada, Grace         | 🟠 [users||2] <fetch-finished (value: {"id":2,"name":"Grace"})
    "
  `);

  hook.unmount();
});

test('discarding a failed offline delete shows the item again on screens that only display that item', async () => {
  network.setOffline();
  const sessionKey = 'offline-discard-delete-item-session';
  type RejectedDeleteOperations = {
    deleteUser: ListQueryOfflineOperationDefinition<
      { id: number; name: string },
      ListQueryParams,
      string,
      { itemId: string },
      unknown
    >;
  };

  // The server rejects the delete on every replay attempt, so it ends up
  // waiting for the user to decide what to do with it.
  const env = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    RejectedDeleteOperations
  >(
    {
      users: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
    },
    {
      id: 'offline-discard-delete-item-store',
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
      testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          operations: {
            deleteUser: {
              inputSchema: deleteItemInputSchema,
              kind: 'delete',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: () => {
                throw new Error('delete rejected');
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  // A detail screen: only Grace's item is displayed, no list is mounted.
  const hook = renderHook(() => {
    const grace = env.apiStore.useItem('users||2');

    env.trackItemUI('grace', grace.data?.name ?? `- ${grace.status}`);
    return grace;
  });
  await flushAllTimers();

  env.addTimelineComments('beforeNextAction', ['offline: delete Grace']);
  await act(async () => {
    await env.apiStore.performMutation('users||2', {
      optimisticUpdate: () => {
        env.apiStore.deleteItemState('users||2');
      },
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: { operation: 'deleteUser', input: { itemId: 'users||2' } },
    });
  });

  env.addTimelineComments('beforeNextAction', [
    'back online: the server rejects the delete until it needs a resolution',
  ]);
  act(() => {
    network.goOnline();
  });
  await advanceTime(15_000);
  await flushAllTimers();

  const [deleteResolution] = env.apiStore.getOfflineResolutions();
  if (!deleteResolution) {
    throw new Error('Expected the delete to be waiting for a resolution');
  }

  // Discard the delete: it never reached the server, so the item is fetched
  // again and the screen shows Grace instead of a deleted item.
  env.addTimelineComments('beforeNextAction', [
    'discard the delete: Grace is fetched again',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      deleteResolution.id,
      'deleteUser',
      { action: 'discard' },
    );
  });
  await flushAllTimers();

  expect(pick(hook.result.current, ['status', 'data'])).toMatchInlineSnapshot(`
    data: { id: 2, name: 'Grace' }
    status: 'success'
  `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | grace     |
    0      | Grace     | [grace] ui-initialized
    3.01s  | Grace     | -- offline: delete Grace
    .      | - deleted | [grace] ui-changed
    .      | - deleted | offline:deleteUser queued
    .      | - deleted | -- back online: the server rejects the delete until it needs a resolution
    .      | - deleted | offline:deleteUser replay-started
    8.01s  | - deleted | offline:deleteUser replay-started
    13.01s | - deleted | offline:deleteUser replay-started
    .      | - deleted | offline:deleteUser resolution-required
    18.02s | - deleted | -- discard the delete: Grace is fetched again
    .      | - loading | [grace] ui-changed
    .      | - loading | 🔴 [users||2] >fetch-started
    18.82s | - loading | 🔴 [users||2] <fetch-finished (value: {"id":2,"name":"Grace"})
    .      | Grace     | [grace] ui-changed
    "
  `);

  hook.unmount();
});

describe('discarding a failed offline creation with a client-generated id', () => {
  type ClientIdCreateInput = {
    itemId: string;
    name: string;
    managerId?: string;
  };
  type ClientIdCreateOperations = PatchUserOperations & {
    createUser: ListQueryOfflineOperationDefinition<
      { id: number; name: string },
      ListQueryParams,
      string,
      ClientIdCreateInput,
      unknown
    >;
    createManager: ListQueryOfflineOperationDefinition<
      { id: number; name: string },
      ListQueryParams,
      string,
      { name: string },
      unknown,
      { id: number; name: string }
    >;
  };
  const clientIdCreateInputSchema = rc_object({
    itemId: rc_string,
    name: rc_string,
    managerId: rc_string.optionalKey(),
  });

  // The app generates the user id on the client, so the creation needs no
  // temp entity: the created item already has its final key. Managers are
  // created with a temp entity, and the server rejects them.
  function createClientIdCreateEnv(
    storeId: string,
    executeCreateUser: (input: ClientIdCreateInput) => unknown,
  ) {
    const sessionKey = `${storeId}-session`;
    const env = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      ClientIdCreateOperations
    >(
      { users: [{ id: 1, name: 'Ada' }] },
      {
        id: storeId,
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
        testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            operations: {
              createUser: {
                inputSchema: clientIdCreateInputSchema,
                kind: 'create',
                getEntityRefs: ({ input }) => [input.itemId],
                dependsOn: ({ input }) =>
                  input.managerId ? [input.managerId] : [],
                execute: ({ input }) => executeCreateUser(input),
                onSuccessExecute: () => {},
              },
              createManager: {
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
                execute: () => {
                  throw new Error('manager creation rejected');
                },
              },
              patchUserName: {
                inputSchema: userPatchSchema,
                kind: 'update',
                getEntityRefs: ({ input }) => [input.itemId],
                execute: async ({ input }) => {
                  await env.serverTable.delayedUpdateItem(input.itemId, {
                    name: input.name,
                  });
                },
                onSuccessExecute: () => {},
              },
            },
          },
        },
      },
    );

    async function createUserOffline(
      id: number,
      name: string,
      managerId?: string,
    ) {
      await act(async () => {
        await env.apiStore.performMutation(`users||${id}`, {
          optimisticUpdate: () => {
            env.apiStore.addItemToState(
              `users||${id}`,
              { id, name },
              {
                addItemToQueries: {
                  queries: [{ tableId: 'users' }],
                  appendTo: 'end',
                },
              },
            );
          },
          mutation: () =>
            Promise.reject(new Error('unreachable while offline')),
          offline: {
            operation: 'createUser',
            input: { itemId: `users||${id}`, name, managerId },
          },
        });
      });
    }

    async function discardResolution(
      operation: 'createUser' | 'patchUserName' | 'createManager',
    ) {
      const resolution = env.apiStore
        .getOfflineResolutions()
        .find((record) => record.operation === operation);
      if (!resolution) {
        throw new Error(`Expected ${operation} to wait for a resolution`);
      }

      await act(async () => {
        await env.apiStore.resolveOfflineResolution(resolution.id, operation, {
          action: 'discard',
        });
      });
      await flushAllTimers();
    }

    // The users list and the detail screen of the user created offline.
    function renderScreens() {
      return renderHook(() => {
        const query = env.apiStore.useListQuery(
          { tableId: 'users' },
          { itemSelector: (item) => item.name },
        );
        const linus = env.apiStore.useItem('users||3');

        env.trackItemUI('rows', query.items.join(', '));
        env.trackItemUI('linus', linus.data?.name ?? `- ${linus.status}`);
      });
    }

    return {
      env,
      sessionKey,
      createUserOffline,
      discardResolution,
      renderScreens,
    };
  }

  test('removes the created item from the store, its lists and the persisted cache', async () => {
    network.setOffline();
    const {
      env,
      sessionKey,
      createUserOffline,
      discardResolution,
      renderScreens,
    } = createClientIdCreateEnv(
      'offline-discard-client-id-create-store',
      () => {
        throw new Error('creation rejected');
      },
    );

    env.addTimelineComments('beforeNextAction', ['offline: create Linus']);
    await createUserOffline(3, 'Linus');

    // The user opens the users list and the detail screen of Linus.
    const hook = renderScreens();
    await flushAllTimers();

    // The server rejects the creation on every replay attempt, so it ends up
    // waiting for the user to decide what to do with it.
    env.addTimelineComments('beforeNextAction', [
      'back online: the server rejects the creation until it needs a resolution',
    ]);
    act(() => {
      network.goOnline();
    });
    await advanceTime(15_000);
    await flushAllTimers();

    // Discarding the creation removes Linus right away, from the list and
    // from his detail screen, like the rollback of a temp entity. He is not
    // fetched: the server never got him. With nothing left to sync, the store
    // revalidates its lists, which confirms he does not exist.
    env.addTimelineComments('beforeNextAction', [
      'discard the creation: Linus is removed',
    ]);
    await discardResolution('createUser');

    // The never-saved item is not readable as loaded data anymore.
    expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`null`);
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    // Its persisted cache entry is gone too, so a reload does not restore it.
    expect(
      getLocalStorageKeys().filter((key) =>
        key.startsWith(
          `tsdf.${sessionKey}.offline-discard-client-id-create-store.li.`,
        ),
      ),
    ).toMatchInlineSnapshot(
      `- 'tsdf.offline-discard-client-id-create-store-session.offline-discard-client-id-create-store.li."users||1'`,
    );
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | linus     | rows       |
      0      | -         | -          | -- offline: create Linus
      .      | -         | -          | offline:createUser queued
      .      | Linus     | Ada, Linus | [rows, linus] ui-initialized
      3.01s  | Linus     | Ada, Linus | -- back online: the server rejects the creation until it needs a resolution
      .      | Linus     | Ada, Linus | offline:createUser replay-started
      8.01s  | Linus     | Ada, Linus | offline:createUser replay-started
      13.01s | Linus     | Ada, Linus | offline:createUser replay-started
      .      | Linus     | Ada, Linus | offline:createUser resolution-required
      18.01s | Linus     | Ada, Linus | -- discard the creation: Linus is removed
      .      | - deleted | Ada        | [rows, linus] ui-changed
      18.02s | - deleted | Ada        | 🔴 >list-fetch-started
      18.82s | - deleted | Ada        | 🔴 <list-fetch-finished (value: {"count":1})
      "
    `);

    hook.unmount();
  });

  test('brings the item back when an earlier attempt did create it on the server', async () => {
    network.setOffline();
    let createAttempts = 0;
    const { env, createUserOffline, discardResolution, renderScreens } =
      createClientIdCreateEnv(
        'offline-discard-client-id-created-on-server-store',
        async (input) => {
          createAttempts += 1;
          if (createAttempts > 1) throw new Error('user already exists');

          // The first attempt creates the user, but its response is lost.
          await env.serverTable.delayedSetItem(input.itemId, {
            id: 3,
            name: input.name,
          });
          throw new Error('connection lost');
        },
      );

    env.addTimelineComments('beforeNextAction', ['offline: create Linus']);
    await createUserOffline(3, 'Linus');

    // The user opens the users list and the detail screen of Linus.
    const hook = renderScreens();
    await flushAllTimers();

    // The first attempt creates Linus on the server but its response is lost,
    // the next ones are rejected because he already exists.
    env.addTimelineComments('beforeNextAction', [
      'back online: the creation reaches the server, its retries are rejected',
    ]);
    act(() => {
      network.goOnline();
    });
    await advanceTime(15_000);
    await flushAllTimers();

    // Discarding removes Linus locally. With nothing left to sync, the store
    // revalidates its lists, which find him on the server: the list and the
    // detail screen show him again.
    env.addTimelineComments('beforeNextAction', [
      'discard the creation: Linus is removed, then restored from the server',
    ]);
    await discardResolution('createUser');

    expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`
      id: 3
      name: 'Linus'
    `);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | linus     | rows       |
      0      | -         | -          | -- offline: create Linus
      .      | -         | -          | offline:createUser queued
      .      | Linus     | Ada, Linus | [rows, linus] ui-initialized
      3.01s  | Linus     | Ada, Linus | -- back online: the creation reaches the server, its retries are rejected
      .      | Linus     | Ada, Linus | offline:createUser replay-started
      4.21s  | Linus     | Ada, Linus | [users||3] server-data-changed (value: {"id":3,"name":"Linus"})
      9.21s  | Linus     | Ada, Linus | offline:createUser replay-started
      14.21s | Linus     | Ada, Linus | offline:createUser replay-started
      .      | Linus     | Ada, Linus | offline:createUser resolution-required
      18.01s | Linus     | Ada, Linus | -- discard the creation: Linus is removed, then restored from the server
      .      | - deleted | Ada        | [rows, linus] ui-changed
      18.02s | - deleted | Ada        | 🔴 >list-fetch-started
      18.82s | - deleted | Ada        | 🔴 <list-fetch-finished (value: {"count":2})
      .      | Linus     | Ada, Linus | [rows, linus] ui-changed
      "
    `);

    hook.unmount();
  });

  test('an edit queued after the creation needs its own decision and does not bring the item back', async () => {
    network.setOffline();
    const { env, createUserOffline, discardResolution, renderScreens } =
      createClientIdCreateEnv(
        'offline-discard-client-id-create-edit-store',
        () => {
          throw new Error('creation rejected');
        },
      );

    env.addTimelineComments('beforeNextAction', [
      'offline: create Linus and rename him',
    ]);
    await createUserOffline(3, 'Linus');
    await act(async () => {
      await env.apiStore.performMutation('users||3', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('users||3', (item) => ({
            ...item,
            name: 'Linus T.',
          }));
        },
        mutation: () => Promise.reject(new Error('unreachable while offline')),
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'users||3', name: 'Linus T.' },
        },
      });
    });

    // The user opens the users list and the detail screen of Linus.
    const hook = renderScreens();
    await flushAllTimers();

    env.addTimelineComments('beforeNextAction', [
      'back online: both changes are rejected until they need a resolution',
    ]);
    act(() => {
      network.goOnline();
    });
    await advanceTime(30_000);
    await flushAllTimers();

    // Unlike the changes made on top of a temp entity, the rename is not held
    // behind the failed creation: it is sent on its own, the server does not
    // know Linus, and it waits for its own decision (it is not blocked by the
    // creation).
    expect(env.apiStore.getOfflineResolutions().map(summarizeResolution))
      .toMatchInlineSnapshot(`
        - error: 'creation rejected'
          input: 'itemId: "users||3", managerId: undefined, name: "Linus"'
          kind: 'retry-exhausted'
          on: 'item:users||3'
          op: 'createUser'
        - error: 'Item not found: users||3'
          input: 'itemId: "users||3", name: "Linus T."'
          kind: 'retry-exhausted'
          on: 'item:users||3'
          op: 'patchUserName'
      `);

    // Discarding the creation removes Linus. Nothing is refetched while the
    // rename still waits for a decision.
    env.addTimelineComments('beforeNextAction', [
      'discard the creation: Linus is removed, no refetch',
    ]);
    await discardResolution('createUser');

    expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`null`);

    // Discarding the rename refetches what it changed: the lists and Linus,
    // which the server does not have. He stays removed.
    env.addTimelineComments('beforeNextAction', [
      'discard the rename: Linus is refetched and not found',
    ]);
    await discardResolution('patchUserName');

    expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`null`);
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | linus     | rows          |
      0      | -         | -             | -- offline: create Linus and rename him
      .      | -         | -             | offline:createUser queued
      .      | -         | -             | offline:patchUserName queued
      .      | Linus T.  | Ada, Linus T. | [rows, linus] ui-initialized
      3.01s  | Linus T.  | Ada, Linus T. | -- back online: both changes are rejected until they need a resolution
      .      | Linus T.  | Ada, Linus T. | offline:createUser replay-started
      8.01s  | Linus T.  | Ada, Linus T. | offline:createUser replay-started
      13.01s | Linus T.  | Ada, Linus T. | offline:createUser replay-started
      .      | Linus T.  | Ada, Linus T. | offline:createUser resolution-required
      .      | Linus T.  | Ada, Linus T. | offline:patchUserName replay-started
      19.21s | Linus T.  | Ada, Linus T. | offline:patchUserName replay-started
      25.41s | Linus T.  | Ada, Linus T. | offline:patchUserName replay-started
      26.61s | Linus T.  | Ada, Linus T. | offline:patchUserName resolution-required
      33.01s | Linus T.  | Ada, Linus T. | -- discard the creation: Linus is removed, no refetch
      .      | - deleted | Ada           | [rows, linus] ui-changed
      34.02s | - deleted | Ada           | -- discard the rename: Linus is refetched and not found
      .      | - deleted | Ada           | 🔴 >list-fetch-started
      .      | - loading | Ada           | [linus] ui-changed
      .      | - loading | Ada           | 🟠 [users||3] >fetch-started
      34.82s | - loading | Ada           | 🔴 <list-fetch-finished (value: {"count":1})
      .      | - error   | Ada           | [linus] ui-changed
      "
    `);

    hook.unmount();
  });

  test('an item created on top of a discarded temp creation is removed with it', async () => {
    network.setOffline();
    const { env, createUserOffline, discardResolution, renderScreens } =
      createClientIdCreateEnv(
        'offline-discard-client-id-under-temp-store',
        () => {
          throw new Error('unreachable: held behind the manager creation');
        },
      );

    // Offline: create the manager Grace (temp entity), then Linus (client id)
    // reporting to her.
    env.addTimelineComments('beforeNextAction', [
      'offline: create Grace, then Linus reporting to her',
    ]);
    await act(async () => {
      await env.apiStore.performMutation('temp:Grace', {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            'temp:Grace',
            { id: -1, name: 'Grace' },
            {
              addItemToQueries: {
                queries: [{ tableId: 'users' }],
                appendTo: 'end',
              },
            },
          );
        },
        mutation: () => Promise.reject(new Error('unreachable while offline')),
        offline: { operation: 'createManager', input: { name: 'Grace' } },
      });
    });
    await createUserOffline(3, 'Linus', 'temp:Grace');

    // The user opens the users list and the detail screen of Linus.
    const hook = renderScreens();
    await flushAllTimers();

    // The server rejects Grace until she needs a resolution. Linus depends on
    // her, so he is held as a blocked resolution without being sent.
    env.addTimelineComments('beforeNextAction', [
      'back online: Grace is rejected until she needs a resolution',
    ]);
    act(() => {
      network.goOnline();
    });
    await advanceTime(15_000);
    await flushAllTimers();

    // Discarding Grace discards Linus with her: both are removed.
    env.addTimelineComments('beforeNextAction', [
      'discard Grace: Linus is discarded and removed with her',
    ]);
    await discardResolution('createManager');

    expect(env.apiStore.getItemState('temp:Grace')).toMatchInlineSnapshot(
      `null`,
    );
    expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`null`);
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | linus     | rows              |
      0      | -         | -                 | -- offline: create Grace, then Linus reporting to her
      .      | -         | -                 | offline:createManager queued
      .      | -         | -                 | offline:createUser queued
      .      | Linus     | Ada, Grace, Linus | [rows, linus] ui-initialized
      3.01s  | Linus     | Ada, Grace, Linus | -- back online: Grace is rejected until she needs a resolution
      .      | Linus     | Ada, Grace, Linus | offline:createManager replay-started
      8.01s  | Linus     | Ada, Grace, Linus | offline:createManager replay-started
      13.01s | Linus     | Ada, Grace, Linus | offline:createManager replay-started
      .      | Linus     | Ada, Grace, Linus | offline:createManager resolution-required
      .      | Linus     | Ada, Grace, Linus | offline:createUser resolution-required
      18.01s | Linus     | Ada, Grace, Linus | -- discard Grace: Linus is discarded and removed with her
      .      | - deleted | Ada               | [rows, linus] ui-changed
      18.02s | - deleted | Ada               | 🔴 >list-fetch-started
      18.82s | - deleted | Ada               | 🔴 <list-fetch-finished (value: {"count":1})
      "
    `);

    hook.unmount();
  });
});
