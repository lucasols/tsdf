import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
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
  type PatchUserOperations,
  replayListQueryCreateWithDelay,
  replayListQueryPatchWithDelay,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  collectionCreateInputSchema,
  listQueryQueryPayloadSchema,
  waitForMicrotaskCondition,
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
type PatchWithAuditOperations = CreateListQueryUserOperations & {
  patchUserNameWithAudit: ListQueryOfflineOperationDefinition<
    { id: number; name: string },
    ListQueryParams,
    string,
    { itemId: string; name: string; auditRef: string },
    unknown
  >;
};

type PatchUserReplayContext = Parameters<
  CreateAndPatchListQueryUserOperations['patchUserName']['execute']
>[0];

const nestedUserRowSchema = rc_object({
  id: rc_number,
  name: rc_string,
  parentId: rc_string.optionalKey(),
});
const nestedChildCreateInputSchema = rc_object({
  name: rc_string,
  parentId: rc_string,
});
const patchWithAuditSchema = rc_object({
  itemId: rc_string,
  name: rc_string,
  auditRef: rc_string,
});

async function replayNestedListQueryCreateWithDelay(
  env: {
    serverTable: {
      delayedSetItem: (
        itemId: string,
        data: NestedListQueryUserRow,
        options?: { durationMs?: number },
      ) => Promise<void>;
    };
  },
  result: NestedListQueryUserRow,
) {
  await env.serverTable.delayedSetItem(`users||${result.id}`, result);
  return result;
}

describe('offline resolution dependencies', () => {
  test('nested descendants cascade into blocked resolutions and discard together', async () => {
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
      .mockRejectedValue(new Error('create replay failed'));
    const createChildUserExecute =
      vi.fn<
        ({
          input,
        }: {
          input: { name: string; parentId: string };
        }) => Promise<NestedListQueryUserRow>
      >();
    const patchUserExecute =
      vi.fn<
        ({
          input,
        }: {
          input: { itemId: string; name: string };
        }) => Promise<{ name: string }>
      >();

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
        id: 'offline-resolution-dependency-chain-store',
        getSessionKey: () => 'offline-resolution-dependency-chain-session',
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: nestedUserRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () =>
                'offline-resolution-dependency-chain-session',
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
                onSuccessExecute: null,
              },
            },
          },
        },
      },
    );
    createChildUserExecute.mockImplementation(
      async ({ input }: { input: { name: string; parentId: string } }) =>
        replayNestedListQueryCreateWithDelay(env, {
          id: 4,
          name: input.name,
          parentId: input.parentId,
        }),
    );
    patchUserExecute.mockImplementation(
      async ({ input }: { input: { itemId: string; name: string } }) =>
        replayListQueryPatchWithDelay(env, input),
    );

    const hook = renderHook(() => {
      const query = env.apiStore.useListQuery(usersQuery, {
        itemSelector: (item) => item.name,
      });

      env.trackItemUI('query-items', query.items.join(', '));
      return query;
    });
    await flushAllTimers();

    // Queue the root temp create while offline so the replay chain starts from
    // a realistic pending parent entity.
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

    // Queue the dependent child temp create using the parent's temp id.
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

    // Queue a grandchild edit so the resolution chain spans multiple levels.
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

    // Reconnect and let the parent replay exhaust so the whole chain promotes
    // into manual resolutions.
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
    await waitForMicrotaskCondition(
      () => env.apiStore.getOfflineResolutions().length === 3,
    );

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
      throw new Error('Expected the full dependency resolution chain');
    }

    expect(createChildUserExecute).not.toHaveBeenCalled();
    expect(patchUserExecute).not.toHaveBeenCalled();
    expect(parentResolution.childResolutionIds).toMatchInlineSnapshot(`
      - '${childCreateResolution.id}'
    `);
    expect(childCreateResolution.blockedByResolutionIds).toMatchInlineSnapshot(`
      - '${parentResolution.id}'
    `);
    expect(childCreateResolution.childResolutionIds).toMatchInlineSnapshot(`
      - '${grandchildResolution.id}'
    `);
    expect(grandchildResolution.blockedByResolutionIds).toMatchInlineSnapshot(`
      - '${childCreateResolution.id}'
    `);
    expect(
      env.apiStore
        .getOfflineResolutions()
        .map((resolution) => ({
          blockedResolutionCount: resolution.blockedResolutionCount,
          childResolutionCount: resolution.childResolutionCount,
          kind: resolution.kind,
          operation: resolution.operation,
          lastReplayError:
            resolution.kind === 'retry-exhausted'
              ? resolution.lastReplayError
              : null,
        }))
        .sort((left, right) => left.operation.localeCompare(right.operation)),
    ).toMatchInlineSnapshot(`
      - blockedResolutionCount: 1
        childResolutionCount: 1
        kind: 'retry-exhausted'
        lastReplayError: { message: 'Blocked by unresolved dependency' }
        operation: 'createChildUser'
      - blockedResolutionCount: 0
        childResolutionCount: 1
        kind: 'retry-exhausted'
        lastReplayError: { message: 'create replay failed' }
        operation: 'createUser'
      - blockedResolutionCount: 1
        childResolutionCount: 0
        kind: 'retry-exhausted'
        lastReplayError: { message: 'Blocked by unresolved dependency' }
        operation: 'patchUserName'
    `);

    // Discarding the parent should recursively clear every blocked descendant.
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

    hook.unmount();
  });

  test('retrying a retry-exhausted parent replays nested descendants by default', async () => {
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
      .mockRejectedValueOnce(new Error('create replay failed'));
    const createChildUserExecute =
      vi.fn<
        ({
          input,
        }: {
          input: { name: string; parentId: string };
        }) => Promise<NestedListQueryUserRow>
      >();
    const patchUserExecute =
      vi.fn<
        ({
          input,
        }: {
          input: { itemId: string; name: string };
        }) => Promise<{ name: string }>
      >();

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
        id: 'offline-resolution-nested-retry-store',
        getSessionKey: () => 'offline-resolution-nested-retry-session',
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: nestedUserRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => 'offline-resolution-nested-retry-session',
              config: {
                network: network.config,
                replayRetry: { maxFailures: 1, intervalMs: 1 },
              },
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
                onSuccessExecute: null,
              },
            },
          },
        },
      },
    );
    createUserExecute.mockImplementationOnce(
      async ({ input }: { input: { name: string } }) =>
        replayListQueryCreateWithDelay(env, { id: 3, name: input.name }),
    );
    createChildUserExecute.mockImplementation(
      async ({ input }: { input: { name: string; parentId: string } }) =>
        replayNestedListQueryCreateWithDelay(env, {
          id: 4,
          name: input.name,
          parentId: input.parentId,
        }),
    );
    patchUserExecute.mockImplementation(
      async ({ input }: { input: { itemId: string; name: string } }) =>
        replayListQueryPatchWithDelay(env, input),
    );

    const hook = renderHook(() =>
      env.apiStore.useListQuery(usersQuery, {
        itemSelector: (item) => item.name,
      }),
    );
    await flushAllTimers();

    // Queue the parent temp create while offline so it becomes the root replay
    // dependency when the app reconnects.
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

    // Queue the child temp create against the parent temp id.
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
            parentId: 'temp:Parent offline',
          }),
        offline: {
          operation: 'createChildUser',
          input: { name: 'Child offline', parentId: 'temp:Parent offline' },
        },
      });
    });

    // Queue a dependent edit so retrying the parent has to cascade into both
    // descendants through the realistic replay pipeline.
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

    // Reconnect, let the parent fail once, and promote it into a manual
    // resolution before retrying it explicitly.
    await act(async () => {
      network.goOnline();
      await Promise.resolve();
      await flushAllTimers();
      await Promise.resolve();
    });

    const parentResolution = env.apiStore
      .getOfflineResolutions()
      .find((resolution) => resolution.operation === 'createUser');
    if (!parentResolution) {
      throw new Error('Expected parent dependency resolution');
    }
    expect(createChildUserExecute).not.toHaveBeenCalled();
    expect(patchUserExecute).not.toHaveBeenCalled();

    // Retrying the parent should replay the child create and the child patch in
    // dependency order, using remapped payload ids.
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        parentResolution.id,
        'createUser',
        { action: 'retry' },
      );
      await Promise.resolve();
    });
    await waitForMicrotaskCondition(
      () => createUserExecute.mock.calls.length === 2,
    );
    await waitForMicrotaskCondition(
      () => createChildUserExecute.mock.calls.length === 1,
    );
    await waitForMicrotaskCondition(
      () => patchUserExecute.mock.calls.length === 1,
    );
    await flushAllTimers();
    await vi.waitFor(() => {
      expect(env.apiStore.getItemState('users||4')).toMatchInlineSnapshot(`
        id: 4
        name: 'Child offline'
        parentId: 'users||3'
      `);
      expect(env.apiStore.getItemState('temp:Child offline')).toBeNull();
    });

    expect(
      createChildUserExecute.mock.calls.map(([ctx]) => ctx.input),
    ).toMatchInlineSnapshot(
      `- { name: 'Child offline', parentId: 'users||3' }`,
    );
    expect(
      patchUserExecute.mock.calls.map(([ctx]) => ctx.input),
    ).toMatchInlineSnapshot(
      `- { itemId: 'users||4', name: 'Child blocked edit' }`,
    );
    expect(hook.result.current.items).toMatchInlineSnapshot(
      `['Ada', 'Grace', 'Parent offline', 'Child offline']`,
    );
    expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`
      id: 3
      name: 'Parent offline'
    `);
    expect(env.apiStore.getItemState('users||4')).toMatchInlineSnapshot(`
      id: 4
      name: 'Child offline'
      parentId: 'users||3'
    `);
    expect(env.apiStore.getItemState('temp:Parent offline')).toBeNull();
    expect(env.apiStore.getItemState('temp:Child offline')).toBeNull();
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);

    hook.unmount();
  });

  test('blocked children unblock after the parent succeeds, remaps, and exposes resolved refs to replay hooks', async () => {
    network.setOffline();
    const usersQuery = { tableId: 'users' } as const;
    const resolvedRefsSeen: string[] = [];
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
    const patchUserExecute =
      vi.fn<(ctx: PatchUserReplayContext) => Promise<{ name: string }>>();

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
        id: 'offline-resolution-remap-store',
        getSessionKey: () => 'offline-resolution-remap-session',
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => 'offline-resolution-remap-session',
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
    createUserExecute.mockImplementationOnce(async () =>
      replayListQueryCreateWithDelay(env, { id: 3, name: 'Linus offline' }),
    );
    patchUserExecute.mockImplementation(async (ctx: PatchUserReplayContext) => {
      resolvedRefsSeen.push(ctx.resolveEntityRef('temp:Linus offline'));
      return replayListQueryPatchWithDelay(env, ctx.input);
    });

    const hook = renderHook(() => {
      const query = env.apiStore.useListQuery(usersQuery, {
        itemSelector: (item) => item.name,
      });

      env.trackItemUI('query-items', query.items.join(', '));
      return query;
    });
    await flushAllTimers();

    // Queue the temp create while offline so later retries must remap the temp
    // id before replaying the dependent patch.
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

    // Queue the dependent edit against the temp id that will later resolve to a
    // real payload during replay.
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

    // Reconnect and let the create exhaust so both operations become manual
    // resolutions with an explicit parent/child dependency.
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
      throw new Error('Expected parent and child dependency resolutions');
    }

    // The child stays blocked until the parent temp create is resolved.
    await expect(
      env.apiStore.resolveOfflineResolution(
        childResolution.id,
        'patchUserName',
        { action: 'retry' },
      ),
    ).rejects.toThrow(
      'Cannot resolve a blocked offline resolution before its blocking dependencies are cleared',
    );

    // Retrying the parent should remap the child input and replay the edit
    // through the delayed server-backed patch path.
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
    await waitForMicrotaskCondition(
      () => patchUserExecute.mock.calls.length === 1,
    );
    await flushAllTimers();
    await waitForMicrotaskCondition(
      () =>
        env.apiStore.getItemState('users||3')?.name === 'Linus blocked edit',
    );

    expect(patchUserExecute.mock.calls.map(([ctx]) => ctx.input))
      .toMatchInlineSnapshot(`
        - { itemId: 'users||3', name: 'Linus blocked edit' }
      `);
    expect(resolvedRefsSeen).toMatchInlineSnapshot(`
      ['users||3']
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

    hook.unmount();
  });

  test('retry scope self keeps descendants as manual resolutions after the parent succeeds', async () => {
    network.setOffline();
    const usersQuery = { tableId: 'users' } as const;
    const resolvedRefsSeen: string[] = [];
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
    const patchUserExecute =
      vi.fn<(ctx: PatchUserReplayContext) => Promise<{ name: string }>>();

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
        id: 'offline-resolution-dependency-self-scope-store',
        getSessionKey: () => 'offline-resolution-dependency-self-scope-session',
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () =>
                'offline-resolution-dependency-self-scope-session',
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
                onSuccessExecute: null,
              },
            },
          },
        },
      },
    );
    createUserExecute.mockImplementationOnce(async () =>
      replayListQueryCreateWithDelay(env, { id: 3, name: 'Linus offline' }),
    );
    patchUserExecute.mockImplementation(
      async ({ input }: PatchUserReplayContext) => {
        resolvedRefsSeen.push(input.itemId);
        return replayListQueryPatchWithDelay(env, input);
      },
    );

    const hook = renderHook(() => env.apiStore.useListQuery(usersQuery));
    await flushAllTimers();

    // Queue the temp create that the child resolution will depend on.
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

    // Queue the child edit against the temp id so scope=self can remap it into
    // a standalone manual resolution without auto-replaying it.
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

    // Reconnect and let the parent exhaust before resolving it manually.
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
    if (!parentResolution || !childResolution) {
      throw new Error('Expected parent and child dependency resolutions');
    }

    // Retrying only the parent should remap the child resolution but keep the
    // child pending for a separate manual retry.
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        parentResolution.id,
        'createUser',
        { action: 'retry', scope: 'self' },
      );
      await Promise.resolve();
    });
    await waitForMicrotaskCondition(
      () => createUserExecute.mock.calls.length === 6,
    );
    await flushAllTimers();

    expect(patchUserExecute).not.toHaveBeenCalled();

    const remappedChildResolution = env.apiStore
      .getOfflineResolutions()
      .find((resolution) => resolution.operation === 'patchUserName');
    expect(env.apiStore.getOfflineResolutions()).toHaveLength(1);
    expect(
      pick(remappedChildResolution, [
        'blockedByResolutionIds',
        'blockedResolutionCount',
        'entityRefs',
        'input',
      ]),
    ).toMatchInlineSnapshot(`
      blockedByResolutionIds: []
      blockedResolutionCount: 0
      entityRefs:
        - entityKey: '"users||3'
          entityKind: 'item'
      input: { itemId: 'users||3', name: 'Linus blocked edit' }
    `);

    // Retry the remapped child separately to prove it now targets the final id
    // through the realistic delayed patch path.
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
    await vi.waitFor(() => {
      expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`
        id: 3
        name: 'Linus offline'
      `);
    });

    expect(patchUserExecute.mock.calls.map(([ctx]) => ctx.input))
      .toMatchInlineSnapshot(`
        - { itemId: 'users||3', name: 'Linus blocked edit' }
      `);
    expect(resolvedRefsSeen).toMatchInlineSnapshot(`
      ['users||3']
    `);
    expect(
      hook.result.current.items.map((item) => item.name),
    ).toMatchInlineSnapshot(`['Ada', 'Grace', 'Linus offline']`);
    expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`
      id: 3
      name: 'Linus offline'
    `);
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

    hook.unmount();
  });

  test('discarding a temp parent resolution clears the dependent chain', async () => {
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
      .mockRejectedValue(new Error('create replay failed'));
    const patchUserExecute =
      vi.fn<
        ({
          input,
        }: {
          input: { itemId: string; name: string };
        }) => Promise<{ name: string }>
      >();

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
        id: 'offline-resolution-discard-store',
        getSessionKey: () => 'offline-resolution-discard-session',
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => 'offline-resolution-discard-session',
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
                onSuccessExecute: null,
              },
            },
          },
        },
      },
    );
    patchUserExecute.mockImplementation(
      async ({ input }: { input: { itemId: string; name: string } }) =>
        replayListQueryPatchWithDelay(env, input),
    );

    const hook = renderHook(() => {
      const query = env.apiStore.useListQuery(usersQuery, {
        itemSelector: (item) => item.name,
      });

      env.trackItemUI('query-items', query.items.join(', '));
      return query;
    });
    await flushAllTimers();

    // Queue the temp create that will become the root manual resolution.
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

    // Queue a dependent edit so discarding the parent has to clear the whole
    // chain, not just the root resolution.
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

    // Reconnect and exhaust the parent replay before discarding it.
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
      throw new Error('Expected the parent dependency resolution');
    }

    // Discarding the parent should clear both the temp entity and the child
    // resolution rooted in it.
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

    hook.unmount();
  });

  test('temp-looking input values do not create dependencies unless dependsOn declares them', async () => {
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
      .mockRejectedValue(new Error('create replay failed'));
    const patchUserExecute =
      vi.fn<
        ({
          input,
        }: {
          input: { itemId: string; name: string; auditRef: string };
        }) => Promise<{ name: string }>
      >();

    const env = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      PatchWithAuditOperations
    >(
      {
        users: [
          { id: 1, name: 'Ada' },
          { id: 2, name: 'Grace' },
        ],
      },
      {
        id: 'offline-resolution-explicit-dep-store',
        getSessionKey: () => 'offline-resolution-explicit-dep-session',
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => 'offline-resolution-explicit-dep-session',
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
              patchUserNameWithAudit: {
                inputSchema: patchWithAuditSchema,
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
    patchUserExecute.mockImplementation(
      async ({
        input,
      }: {
        input: { itemId: string; name: string; auditRef: string };
      }) => {
        await env.serverTable.delayedUpdateItem(input.itemId, {
          name: input.name,
        });
        return { name: input.name };
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

    // Queue a failing temp create so the session has one real dependency root.
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

    // Queue an unrelated edit whose input happens to look like a temp id in an
    // audit field. Because dependsOn is not declared, it should not be blocked.
    await act(async () => {
      await env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('users||1', (item) => ({
            ...item,
            name: 'Ada unrelated edit',
          }));
        },
        mutation: () => Promise.resolve({ name: 'Ada unrelated edit' }),
        offline: {
          operation: 'patchUserNameWithAudit',
          input: {
            itemId: 'users||1',
            name: 'Ada unrelated edit',
            auditRef: 'temp:Linus offline',
          },
        },
      });
    });

    // Reconnect and exhaust only the create replay. The unrelated patch should
    // stay pending rather than being turned into a blocked dependency
    // resolution.
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

    expect(patchUserExecute).not.toHaveBeenCalled();
    expect(
      env.apiStore
        .getOfflineResolutions()
        .find(
          (resolution) => resolution.operation === 'patchUserNameWithAudit',
        ),
    ).toBeUndefined();
    expect(
      pick(
        env.apiStore
          .getOfflineEntities()
          .find(
            (entity) =>
              entity.entityKey === env.getStoreItemKeyFromRaw('users||1'),
          ),
        ['pendingMutations', 'requiresResolution', 'syncState'],
      ),
    ).toMatchInlineSnapshot(`
      pendingMutations: 1
      requiresResolution: '❌'
      syncState: 'pending'
    `);

    hook.unmount();
  });
});
