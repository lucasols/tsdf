import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

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
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  classifyRetryableReplayFailure,
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

/**
 * Exhaust the default healthy replay retry budget (3 attempts at 5 s intervals).
 * Waits for the first attempt, then advances through the remaining 2.
 */
async function exhaustDefaultRetryBudget(
  executeMock: { mock: { calls: unknown[] } },
  startingCallCount = 0,
) {
  await waitForMicrotaskCondition(
    () => executeMock.mock.calls.length === startingCallCount + 1,
  );
  for (const attempt of [2, 3]) {
    await advanceTime(5_000);
    await waitForMicrotaskCondition(
      () => executeMock.mock.calls.length === startingCallCount + attempt,
    );
  }
}

type NestedTempCreateListQueryUserOperations = CreateListQueryUserOperations &
  CreateChildListQueryUserOperations &
  PatchNestedListQueryUserOperations;

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
            getSessionKey: () => 'offline-resolution-dependency-chain-session',
            config: {
              network: network.config,
              classifyRetryableFailure: (error, ctx) =>
                classifyRetryableReplayFailure(error, ctx.phase),
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
  createChildUserExecute.mockImplementation(
    async ({ input }: { input: { name: string; parentId: string } }) => {
      const result = { id: 4, name: input.name, parentId: input.parentId };
      await env.serverTable.delayedSetItem('users||4', result);
      return result;
    },
  );
  patchUserExecute.mockImplementation(
    async ({ input }: { input: { itemId: string; name: string } }) =>
      env.serverTable
        .delayedUpdateItem(input.itemId, { name: input.name })
        .then(() => ({ name: input.name })),
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
      mutation: async () => {
        const result = { id: 3, name: 'Parent offline' };
        await env.serverTable.delayedSetItem('users||3', result);
        return result;
      },
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
      mutation: async () => {
        const result = { id: 4, name: 'Child offline', parentId: 'users||3' };
        await env.serverTable.delayedSetItem('users||4', result);
        return result;
      },
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

  // Reconnect and let the parent replay exhaust its 3-attempt budget so the
  // whole chain (parent → child → grandchild) promotes into manual resolutions.
  env.addTimelineComments('beforeNextAction', [
    'go online — parent create replay will fail 3 times, cascading blocked status to descendants',
  ]);
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await exhaustDefaultRetryBudget(createUserExecute);
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
  if (!parentResolution || !childCreateResolution || !grandchildResolution) {
    throw new Error('Expected the full dependency resolution chain');
  }

  // Neither the child nor the grandchild should have attempted replay — they
  // were blocked by the unresolved parent dependency the entire time.
  expect(createChildUserExecute).not.toHaveBeenCalled();
  expect(patchUserExecute).not.toHaveBeenCalled();

  // Verify the resolution graph: parent → child → grandchild, each blocked by
  // its immediate ancestor.
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

  // Discarding the parent should recursively clear every blocked descendant,
  // remove all temp entities, and restore the list to its original state.
  env.addTimelineComments('beforeNextAction', [
    'discard the parent — should cascade-remove child and grandchild resolutions',
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
    3.01s  | Ada, Grace, Parent offline                     | ui-changed
    .      | Ada, Grace, Parent offline                     | offline:createUser queued
    .      | Ada, Grace, Parent offline, Child offline      | ui-changed
    .      | Ada, Grace, Parent offline, Child offline      | offline:createChildUser queued
    .      | Ada, Grace, Parent offline, Child blocked edit | ui-changed
    .      | Ada, Grace, Parent offline, Child blocked edit | offline:patchUserName queued
    .      | Ada, Grace, Parent offline, Child blocked edit | -- go online — parent create replay will fail 3 times, cascading blocked status to descendants
    .      | Ada, Grace, Parent offline, Child blocked edit | offline:createUser replay-started
    8.01s  | Ada, Grace, Parent offline, Child blocked edit | offline:createUser replay-started
    13.01s | Ada, Grace, Parent offline, Child blocked edit | offline:createUser replay-started
    .      | Ada, Grace, Parent offline, Child blocked edit | offline:createChildUser resolution-required
    .      | Ada, Grace, Parent offline, Child blocked edit | offline:createUser resolution-required
    .      | Ada, Grace, Parent offline, Child blocked edit | offline:patchUserName resolution-required
    .      | Ada, Grace, Parent offline, Child blocked edit | -- discard the parent — should cascade-remove child and grandchild resolutions
    .      | Ada, Grace                                     | ui-changed
    "
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
              classifyRetryableFailure: (error, ctx) =>
                classifyRetryableReplayFailure(error, ctx.phase),
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
  createUserExecute.mockImplementationOnce(
    async ({ input }: { input: { name: string } }) => {
      const result = { id: 3, name: input.name };
      await env.serverTable.delayedSetItem('users||3', result);
      return result;
    },
  );
  createChildUserExecute.mockImplementation(
    async ({ input }: { input: { name: string; parentId: string } }) => {
      const result = { id: 4, name: input.name, parentId: input.parentId };
      await env.serverTable.delayedSetItem('users||4', result);
      return result;
    },
  );
  patchUserExecute.mockImplementation(
    async ({ input }: { input: { itemId: string; name: string } }) =>
      env.serverTable
        .delayedUpdateItem(input.itemId, { name: input.name })
        .then(() => ({ name: input.name })),
  );

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      itemSelector: (item) => item.name,
    });
    env.trackItemUI('query-items', query.items.join(', '));
    return query;
  });
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
      mutation: async () => {
        const result = { id: 3, name: 'Parent offline' };
        await env.serverTable.delayedSetItem('users||3', result);
        return result;
      },
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
      mutation: async () => {
        const result = {
          id: 4,
          name: 'Child offline',
          parentId: 'temp:Parent offline',
        };
        await env.serverTable.delayedSetItem('users||4', result);
        return result;
      },
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

  // Reconnect — with maxFailures=1 the parent fails once and immediately
  // promotes into a manual resolution, blocking its two descendants.
  env.addTimelineComments('beforeNextAction', [
    'go online — parent create fails once (maxFailures=1), promoting the chain into resolutions',
  ]);
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
  // Neither descendant should have replayed — both blocked by the parent.
  expect(createChildUserExecute).not.toHaveBeenCalled();
  expect(patchUserExecute).not.toHaveBeenCalled();

  // Retrying the parent should replay the child create and the child patch in
  // dependency order, using remapped payload ids (temp → users||N).
  env.addTimelineComments('beforeNextAction', [
    'retry parent — should cascade: parent create → child create → child edit, all with remapped ids',
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
    () => createUserExecute.mock.calls.length === 2,
  );
  await waitForMicrotaskCondition(
    () => createChildUserExecute.mock.calls.length === 1,
  );
  await flushAllTimers();
  await waitForMicrotaskCondition(
    () => patchUserExecute.mock.calls.length === 1,
  );
  await vi.waitFor(() => {
    expect(env.apiStore.getItemState('users||4')).toMatchInlineSnapshot(`
      id: 4
      name: 'Child blocked edit'
      parentId: 'users||3'
    `);
  });

  // The child create received the parent's final payload as parentId, proving
  // the dependency remap worked through the replay chain.
  expect(
    createChildUserExecute.mock.calls.map(([ctx]) => ctx.input),
  ).toMatchInlineSnapshot(`- { name: 'Child offline', parentId: 'users||3' }`);
  // The grandchild edit received the child's final payload, proving the
  // second-level remap also worked.
  expect(
    patchUserExecute.mock.calls.map(([ctx]) => ctx.input),
  ).toMatchInlineSnapshot(
    `- { itemId: 'users||4', name: 'Child blocked edit' }`,
  );

  // After the full cascade, temp entities are reconciled and the list keeps
  // the replayed child edit visible through the normal success callback path.
  expect(hook.result.current.items).toMatchInlineSnapshot(
    `['Ada', 'Grace', 'Parent offline', 'Child blocked edit']`,
  );
  expect(env.apiStore.getItemState('temp:Parent offline')).toBeNull();
  expect(env.apiStore.getItemState('temp:Child offline')).toBeNull();
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | query-items                                    |
    0     | Ada, Grace                                     | [query-items] ui-initialized
    3.01s | Ada, Grace, Parent offline                     | [query-items] ui-changed
    .     | Ada, Grace, Parent offline                     | offline:createUser queued
    .     | Ada, Grace, Parent offline, Child offline      | [query-items] ui-changed
    .     | Ada, Grace, Parent offline, Child offline      | offline:createChildUser queued
    .     | Ada, Grace, Parent offline, Child blocked edit | [query-items] ui-changed
    .     | Ada, Grace, Parent offline, Child blocked edit | offline:patchUserName queued
    .     | Ada, Grace, Parent offline, Child blocked edit | -- go online — parent create fails once (maxFailures=1), promoting the chain into resolutions
    .     | Ada, Grace, Parent offline, Child blocked edit | offline:createUser replay-started
    .     | Ada, Grace, Parent offline, Child blocked edit | offline:createChildUser resolution-required
    .     | Ada, Grace, Parent offline, Child blocked edit | offline:createUser resolution-required
    .     | Ada, Grace, Parent offline, Child blocked edit | offline:patchUserName resolution-required
    4.01s | Ada, Grace, Parent offline, Child blocked edit | -- retry parent — should cascade: parent create → child create → child edit, all with remapped ids
    .     | Ada, Grace, Parent offline, Child blocked edit | offline:createUser replay-started
    5.21s | Ada, Grace, Parent offline, Child blocked edit | [users||3] server-data-changed (value: {"id":3,"name":"Parent offline"})
    .     | Ada, Grace, Parent offline, Child blocked edit | offline:createUser replay-finished
    .     | Ada, Grace, Parent offline, Child blocked edit | [query-items, query-items] ui-changed
    .     | Ada, Grace, Parent offline, Child blocked edit | offline:createChildUser replay-started
    6.41s | Ada, Grace, Parent offline, Child blocked edit | [users||4] server-data-changed (value: {"id":4,"name":"Child offline","parentId":"users||3"})
    .     | Ada, Grace, Parent offline, Child blocked edit | offline:createChildUser replay-finished
    .     | Ada, Grace, Parent offline, Child blocked edit | [query-items, query-items] ui-changed
    .     | Ada, Grace, Parent offline, Child blocked edit | offline:patchUserName replay-started
    7.61s | Ada, Grace, Parent offline, Child blocked edit | [users||4] server-data-changed (value: {"name":"Child blocked edit"})
    .     | Ada, Grace, Parent offline, Child blocked edit | offline:patchUserName replay-finished
    "
  `);

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
            config: {
              network: network.config,
              classifyRetryableFailure: (error, ctx) =>
                classifyRetryableReplayFailure(error, ctx.phase),
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
  createUserExecute.mockImplementationOnce(async () => {
    const result = { id: 3, name: 'Linus offline' };
    await env.serverTable.delayedSetItem('users||3', result);
    return result;
  });
  patchUserExecute.mockImplementation(async (ctx: PatchUserReplayContext) => {
    resolvedRefsSeen.push(ctx.resolveEntityRef('temp:Linus offline'));
    await env.serverTable.delayedUpdateItem(ctx.input.itemId, {
      name: ctx.input.name,
    });
    return { name: ctx.input.name };
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
      mutation: async () => {
        const result = { id: 3, name: 'Linus offline' };
        await env.serverTable.delayedSetItem('users||3', result);
        return result;
      },
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

  // Reconnect and let the create exhaust so both operations become manual
  // resolutions with an explicit parent/child dependency.
  env.addTimelineComments('beforeNextAction', [
    'go online — parent create fails 3 times, both operations become manual resolutions',
  ]);
  act(() => {
    network.goOnline();
  });
  await exhaustDefaultRetryBudget(createUserExecute);
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

  // Attempting to resolve the child while the parent is still pending should
  // throw — the dependency chain must be resolved top-down.
  await expect(
    env.apiStore.resolveOfflineResolution(childResolution.id, 'patchUserName', {
      action: 'retry',
    }),
  ).rejects.toThrow(
    'Cannot resolve a blocked offline resolution before its blocking dependencies are cleared',
  );

  // Retrying the parent should remap the child's temp input to the parent's
  // final payload and replay the edit with the resolved ref available.
  env.addTimelineComments('beforeNextAction', [
    'retry parent — child edit input should be remapped from temp:Linus offline → users||3',
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
  await waitForMicrotaskCondition(
    () => env.apiStore.getItemState('users||3')?.name === 'Linus blocked edit',
  );

  // The child edit received the parent's final payload, confirming the remap.
  expect(patchUserExecute.mock.calls.map(([ctx]) => ctx.input))
    .toMatchInlineSnapshot(`
      - { itemId: 'users||3', name: 'Linus blocked edit' }
    `);
  // resolveEntityRef inside the replay hook also returned the final payload.
  expect(resolvedRefsSeen).toMatchInlineSnapshot(`
    ['users||3']
  `);
  expect(hook.result.current.items).toMatchInlineSnapshot(`
    ['Ada', 'Grace', 'Linus blocked edit']
  `);
  expect(env.apiStore.getItemState('temp:Linus offline')).toBeNull();
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | query-items                    |
    0      | Ada, Grace                     | [query-items] ui-initialized
    3.01s  | Ada, Grace, Linus offline      | [query-items] ui-changed
    .      | Ada, Grace, Linus offline      | offline:createUser queued
    .      | Ada, Grace, Linus blocked edit | [query-items] ui-changed
    .      | Ada, Grace, Linus blocked edit | offline:patchUserName queued
    .      | Ada, Grace, Linus blocked edit | -- go online — parent create fails 3 times, both operations become manual resolutions
    .      | Ada, Grace, Linus blocked edit | offline:createUser replay-started
    8.01s  | Ada, Grace, Linus blocked edit | offline:createUser replay-started
    13.01s | Ada, Grace, Linus blocked edit | offline:createUser replay-started
    .      | Ada, Grace, Linus blocked edit | offline:createUser resolution-required
    .      | Ada, Grace, Linus blocked edit | offline:patchUserName resolution-required
    .      | Ada, Grace, Linus blocked edit | -- retry parent — child edit input should be remapped from temp:Linus offline → users||3
    .      | Ada, Grace, Linus blocked edit | offline:createUser replay-started
    14.21s | Ada, Grace, Linus blocked edit | [users||3] server-data-changed (value: {"id":3,"name":"Linus offline"})
    .      | Ada, Grace, Linus blocked edit | offline:createUser replay-finished
    .      | Ada, Grace, Linus blocked edit | [query-items, query-items] ui-changed
    .      | Ada, Grace, Linus blocked edit | offline:patchUserName replay-started
    15.41s | Ada, Grace, Linus blocked edit | [users||3] server-data-changed (value: {"name":"Linus blocked edit"})
    .      | Ada, Grace, Linus blocked edit | offline:patchUserName replay-finished
    "
  `);

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
            config: {
              network: network.config,
              classifyRetryableFailure: (error, ctx) =>
                classifyRetryableReplayFailure(error, ctx.phase),
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
  createUserExecute.mockImplementationOnce(async () => {
    const result = { id: 3, name: 'Linus offline' };
    await env.serverTable.delayedSetItem('users||3', result);
    return result;
  });
  patchUserExecute.mockImplementation(
    async ({ input }: PatchUserReplayContext) => {
      resolvedRefsSeen.push(input.itemId);
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
      mutation: async () => {
        const result = { id: 3, name: 'Linus offline' };
        await env.serverTable.delayedSetItem('users||3', result);
        return result;
      },
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

  // Reconnect and let the parent exhaust before resolving it manually.
  env.addTimelineComments('beforeNextAction', [
    'go online — parent create fails 3 times, both operations become manual resolutions',
  ]);
  act(() => {
    network.goOnline();
  });
  await exhaustDefaultRetryBudget(createUserExecute);
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

  // scope: 'self' retries only the parent — the child is remapped from
  // temp:Linus offline → users||3 but left as a standalone manual resolution.
  env.addTimelineComments('beforeNextAction', [
    'retry parent with scope=self — child should be remapped but NOT auto-replayed',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      parentResolution.id,
      'createUser',
      { action: 'retry', scope: 'self' },
    );
    await Promise.resolve();
  });
  await waitForMicrotaskCondition(
    () => createUserExecute.mock.calls.length === 4,
  );
  await flushAllTimers();

  expect(patchUserExecute).not.toHaveBeenCalled();

  // After scope=self, only the child resolution remains — now unblocked and
  // remapped from the temp entity to the parent's final payload.
  expect(env.apiStore.getOfflineResolutions()).toHaveLength(1);
  const remappedChildResolution = env.apiStore
    .getOfflineResolutions()
    .find((resolution) => resolution.operation === 'patchUserName');
  if (!remappedChildResolution) {
    throw new Error('Expected remapped child resolution');
  }
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
  expect(hook.result.current.items).toMatchInlineSnapshot(`
    ['Ada', 'Grace', 'Linus blocked edit']
  `);

  // Retry the remapped child separately to prove it now targets the final id
  // through the realistic delayed patch path.
  env.addTimelineComments('beforeNextAction', [
    'retry remapped child — should patch users||3 directly',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      remappedChildResolution.id,
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
      name: 'Linus blocked edit'
    `);
  });

  expect(patchUserExecute.mock.calls.map(([ctx]) => ctx.input))
    .toMatchInlineSnapshot(`
      - { itemId: 'users||3', name: 'Linus blocked edit' }
    `);
  expect(resolvedRefsSeen).toMatchInlineSnapshot(`
    ['users||3']
  `);
  expect(hook.result.current.items).toMatchInlineSnapshot(
    `['Ada', 'Grace', 'Linus blocked edit']`,
  );
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | query-items                    |
    0      | Ada, Grace                     | [query-items] ui-initialized
    3.01s  | Ada, Grace, Linus offline      | [query-items] ui-changed
    .      | Ada, Grace, Linus offline      | offline:createUser queued
    .      | Ada, Grace, Linus blocked edit | [query-items] ui-changed
    .      | Ada, Grace, Linus blocked edit | offline:patchUserName queued
    .      | Ada, Grace, Linus blocked edit | -- go online — parent create fails 3 times, both operations become manual resolutions
    .      | Ada, Grace, Linus blocked edit | offline:createUser replay-started
    8.01s  | Ada, Grace, Linus blocked edit | offline:createUser replay-started
    13.01s | Ada, Grace, Linus blocked edit | offline:createUser replay-started
    .      | Ada, Grace, Linus blocked edit | offline:createUser resolution-required
    .      | Ada, Grace, Linus blocked edit | offline:patchUserName resolution-required
    .      | Ada, Grace, Linus blocked edit | -- retry parent with scope=self — child should be remapped but NOT auto-replayed
    .      | Ada, Grace, Linus blocked edit | offline:createUser replay-started
    14.21s | Ada, Grace, Linus blocked edit | [users||3] server-data-changed (value: {"id":3,"name":"Linus offline"})
    .      | Ada, Grace, Linus blocked edit | offline:createUser replay-finished
    .      | Ada, Grace, Linus blocked edit | [query-items, query-items] ui-changed
    15.21s | Ada, Grace, Linus blocked edit | -- retry remapped child — should patch users||3 directly
    .      | Ada, Grace, Linus blocked edit | offline:patchUserName replay-started
    16.41s | Ada, Grace, Linus blocked edit | [users||3] server-data-changed (value: {"name":"Linus blocked edit"})
    .      | Ada, Grace, Linus blocked edit | offline:patchUserName replay-finished
    "
  `);

  hook.unmount();
});

type PatchWithAuditOperations = CreateListQueryUserOperations & {
  patchUserNameWithAudit: ListQueryOfflineOperationDefinition<
    { id: number; name: string },
    ListQueryParams,
    string,
    { itemId: string; name: string; auditRef: string },
    unknown
  >;
};

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
            config: {
              network: network.config,
              classifyRetryableFailure: (error, ctx) =>
                classifyRetryableReplayFailure(error, ctx.phase),
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
      mutation: async () => {
        const result = { id: 3, name: 'Linus offline' };
        await env.serverTable.delayedSetItem('users||3', result);
        return result;
      },
      offline: { operation: 'createUser', input: { name: 'Linus offline' } },
    });
  });

  // Queue an unrelated edit whose input happens to contain a temp id in its
  // auditRef field. Because patchUserNameWithAudit has no `dependsOn`, this
  // edit should replay independently — the temp-looking value is just data.
  await act(async () => {
    await env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', (item) => ({
          ...item,
          name: 'Ada unrelated edit',
        }));
      },
      mutation: async () => {
        await env.serverTable.delayedUpdateItem('users||1', {
          name: 'Ada unrelated edit',
        });
        return { name: 'Ada unrelated edit' };
      },
      offline: {
        operation: 'patchUserNameWithAudit',
        input: {
          itemId: 'users||1',
          name: 'Ada unrelated edit',
          // Deliberately contains a temp ref — but without dependsOn, this
          // should NOT create a dependency on the createUser operation.
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
  await exhaustDefaultRetryBudget(createUserExecute);
  await flushAllTimers();

  // The unrelated patch should NOT become a blocked resolution — it has no
  // dependsOn declaration, so it stays in the normal pending queue.
  expect(patchUserExecute).not.toHaveBeenCalled();
  expect(
    env.apiStore
      .getOfflineResolutions()
      .find((resolution) => resolution.operation === 'patchUserNameWithAudit'),
  ).toBeUndefined();
  // The edit targeting Ada is still pending (waiting for its own replay), not
  // marked as requiring resolution — confirming it was never linked to the
  // failing createUser dependency chain.
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
