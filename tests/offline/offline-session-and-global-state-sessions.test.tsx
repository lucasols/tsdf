import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  getGlobalOfflineEntities,
  getGlobalOfflineStatus,
  useGlobalOfflineEntities,
} from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import {
  type CreateListQueryUserOperations,
  getOfflineQueueEntries,
  type PatchUserOperations,
  type UpdateValueExecuteContext,
  type UpdateValueOperations,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  classifyRetryableReplayFailure,
  collectionCreateInputSchema,
  docMutationInputSchema,
  docSchema,
  listQueryQueryPayloadSchema,
  waitForMicrotaskCondition,
} from './offlineTestShared';

let network = createOfflineNetworkMock();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  network = createOfflineNetworkMock();
  network.install();
  resetSessionForTests({ clearStorage: true });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  resetSessionForTests({ clearStorage: true });
});

test('persistent storage without offline config keeps the existing online flow even when the browser reports offline', async () => {
  network.setOffline();

  const sessionKey = 'offline-opt-in-required';
  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => sessionKey,
    testScenario: 'idle',
    persistentStorage: { adapter: 'local-sync', schema: docSchema },
  });

  // Without offline config, the store should operate normally even when the browser is offline.
  env.scheduleFetch('highPriority');
  await flushAllTimers();

  expect(env.store.state).toMatchInlineSnapshot(`
    data: { value: 1 }
    error: null
    refetchOnMount: '❌'
    status: 'success'
  `);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(
    pick(getGlobalOfflineStatus(sessionKey), [
      'isOfflineMode',
      'isLeader',
      'lastFailureAt',
      'lastRecoveryCheckAt',
      'network',
      'outage',
      'sessionKey',
    ]),
  ).toMatchInlineSnapshot(`
    isLeader: '✅'
    isOfflineMode: '❌'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'offline-opt-in-required'
  `);
});

// Protects against stale offline entities leaking after logout: when the session
// key becomes unavailable, the store must unregister from the previous session.
test('stores unregister their previous offline session when the session key becomes unavailable', async () => {
  network.setOffline();

  let currentSessionKey: string | false = 'offline-session-cleanup';
  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: 'offline-session-cleanup-doc',
    getSessionKey: () => currentSessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => currentSessionKey,
      offlineSession: { network: network.config },
    }),
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            execute: async ({ input }: UpdateValueExecuteContext) => {
              await env.serverMock.delayedSetData(input.value);
              return input;
            },
            onSuccessExecute: ({ input }) => {
              env.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
            },
          },
        },
      },
    },
  });

  await act(async () => {
    await env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: async () => {
        await env.serverMock.delayedSetData(2);
        return 2;
      },
      offline: { operation: 'updateValue', input: { value: 2 } },
    });
  });

  expect(getGlobalOfflineEntities('offline-session-cleanup'))
    .toMatchInlineSnapshot(`
      - blockedByResolutionIds: []
        blockedResolutionCount: 0
        childResolutionCount: 0
        childResolutionIds: []
        createdAt: 1735689600000
        entityKey: 'document'
        entityKind: 'document'
        id: 'offline-session-cleanup:offline-session-cleanup-doc:document'
        kind: 'update'
        pendingMutations: 1
        requiresResolution: '❌'
        sessionKey: 'offline-session-cleanup'
        storeName: 'offline-session-cleanup-doc'
        storeType: 'document'
        syncState: 'pending'
        updatedAt: 1735689600000
    `);

  // Simulate logout so the store no longer belongs to the previous session.
  currentSessionKey = false;

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(
    getGlobalOfflineEntities('offline-session-cleanup'),
  ).toMatchInlineSnapshot(`[]`);
});

test('logging back into the same session replays durable offline mutations queued before logout', async () => {
  network.setOffline();

  const sessionKey = 'offline-session-resume';
  const storeName = 'offline-session-resume-doc';
  let currentSessionKey: string | false = sessionKey;
  const replayedInputs: { value: number }[] = [];

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: storeName,
    getSessionKey: () => currentSessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => currentSessionKey,
      offlineSession: { network: network.config },
    }),
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            execute: async ({ input }: UpdateValueExecuteContext) => {
              replayedInputs.push(input);
              await env.serverMock.delayedSetData(input.value);
              return input;
            },
            onSuccessExecute: ({ input }) => {
              env.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
            },
          },
        },
      },
    },
  });

  const hook = renderHook(() => {
    const doc = env.apiStore.useDocument();
    env.trackUIChanges(
      `value:${doc.data?.value ?? 'null'} pending:${doc.pendingSync ? 'yes' : 'no'}`,
    );
    return doc;
  });

  await Promise.resolve();

  // Queue an optimistic mutation while the app is offline.
  await act(async () => {
    await env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: async () => {
        await env.serverMock.delayedSetData(2);
        return 2;
      },
      offline: { operation: 'updateValue', input: { value: 2 } },
    });
  });

  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);
  expect(replayedInputs).toMatchInlineSnapshot(`[]`);

  // Logging out should detach the current store view without deleting the
  // durable offline queue that belongs to the previous session.
  currentSessionKey = false;
  hook.rerender();

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);

  // Connectivity can recover while logged out, but the old session must remain
  // dormant until that same session becomes active again.
  env.addTimelineComments('beforeNextAction', [
    'the browser goes back online while the app is logged out',
  ]);
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(replayedInputs).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);

  // Once the same session logs back in, a normal online fetch cycle should
  // reattach the session, replay the stored mutation, and clear the queue.
  env.addTimelineComments('beforeNextAction', [
    'the same session logs back in and triggers a normal online fetch',
  ]);
  currentSessionKey = sessionKey;
  hook.rerender();
  env.scheduleFetch('highPriority');
  await advanceTime(250);
  await flushAllTimers();

  expect(replayedInputs).toMatchInlineSnapshot(`
    - value: 2
  `);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  await flushAllTimers();
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui                    |
    0      | "value:1 pending:no"  | ui-initialized
    .      | "value:2 pending:no"  | ui-changed
    .      | "value:2 pending:yes" | ui-changed
    .      | "value:2 pending:yes" | offline:updateValue queued
    .      | "value:2 pending:yes" | session-key-changed (from: offline-session-resume, to: false)
    .      | "value:2 pending:no"  | ui-changed
    10ms   | "value:2 pending:no"  | -- the browser goes back online while the app is logged out
    .      | "value:2 pending:no"  | 🔴 >fetch-started
    810ms  | "value:2 pending:no"  | 🔴 <fetch-finished (value: 1)
    .      | "value:1 pending:no"  | ui-changed
    12s    | "value:1 pending:no"  | -- the same session logs back in and triggers a normal online fetch
    .      | "value:1 pending:no"  | session-key-changed (from: false, to: offline-session-resume)
    .      | "value:1 pending:no"  | scheduled-fetch-triggered
    12.01s | "value:1 pending:yes" | ui-changed
    .      | "value:1 pending:yes" | 🟠 >fetch-started
    .      | "value:1 pending:yes" | offline:updateValue replay-started
    12.81s | "value:1 pending:yes" | 🟠 <fetch-finished (value: 1)
    13.21s | "value:1 pending:yes" | server-data-changed (value: 2)
    .      | "value:1 pending:yes" | offline:updateValue replay-finished
    .      | "value:2 pending:no"  | ui-changed
    13.22s | "value:2 pending:no"  | 🟡 >fetch-started
    14.02s | "value:2 pending:no"  | 🟡 <fetch-finished (value: 2)
    "
  `);
  hook.unmount();
});

type CreateAndPatchListQueryUserOperations = CreateListQueryUserOperations &
  PatchUserOperations;

test('a global offline view sees the same blocked temp item as the store after replay stalls on a temp create', async () => {
  network.setOffline();

  const sessionKey = 'offline-session-temp-create-dependencies';
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
      id: 'offline-session-temp-create-dependencies-store',
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
              execute: createUserExecute,
            },
            patchUserName: {
              inputSchema: userPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: async ({ input }) => {
                await env.serverTable.delayedUpdateItem(input.itemId, {
                  name: input.name,
                });
                return { name: input.name };
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

  const queryHook = renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      itemSelector: (item) => item.name,
    });

    env.trackItemUI('query-items', query.items.join(', '));
    return query;
  });
  await flushAllTimers();

  // The user creates a record offline and immediately edits it before the app
  // has ever managed to sync that temp item to the server.
  env.addTimelineComments('beforeNextAction', [
    'queue a temp create and then edit the same temp item while still offline',
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
        const data = { id: 3, name: 'Linus offline' };
        await env.serverTable.delayedSetItem('users||3', data);
        return data;
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

  // When connectivity returns, replay keeps failing the temp create until the
  // app gives up and asks the user to resolve that blocked chain manually.
  env.addTimelineComments('beforeNextAction', [
    'go back online and let replay exhaust every retry for the temp create',
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

  // A list screen and a global offline tray should now agree about the same
  // unresolved temp item and expose the dependency chain needed to resolve it.
  const parentResolution = env.apiStore
    .getOfflineResolutions()
    .find((resolution) => resolution.operation === 'createUser');
  const childResolution = env.apiStore
    .getOfflineResolutions()
    .find((resolution) => resolution.operation === 'patchUserName');
  const storeHook = renderHook(() => env.apiStore.useOfflineEntities());
  const globalHook = renderHook(() => useGlobalOfflineEntities(sessionKey));
  const [storeEntity] = storeHook.result.current;
  const [globalEntity] = globalHook.result.current;

  expect(pick(queryHook.result.current, ['items', 'pendingSync', 'status']))
    .toMatchInlineSnapshot(`
      items: ['Ada', 'Grace', 'Linus blocked edit']
      pendingSync: '❌'
      status: 'success'
    `);

  // The store-scoped offline view shows the temp item as a manual-resolution
  // problem: it is blocked by the failed create and has the edit as a child.
  expect(storeEntity?.blockedByResolutionIds).toHaveLength(1);
  expect(storeEntity?.blockedByResolutionIds[0]).toBe(parentResolution?.id);
  expect(storeEntity?.childResolutionIds).toHaveLength(1);
  expect(storeEntity?.childResolutionIds[0]).toBe(childResolution?.id);
  expect(
    pick(storeEntity, [
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
    createdAt: 1735689622000
    entityKey: '"temp:Linus offline'
    entityKind: 'item'
    id: 'offline-session-temp-create-dependencies:offline-session-temp-create-dependencies-store:"temp:Linus offline'
    pendingMutations: 0
    requiresResolution: '✅'
    sessionKey: 'offline-session-temp-create-dependencies'
    storeName: 'offline-session-temp-create-dependencies-store'
    storeType: 'listQuery'
    syncState: 'resolution-required'
    tempId: 'temp:Linus offline'
    updatedAt: 1735689622000
  `);

  // The global session-level view should surface the exact same unresolved
  // entity so an app-wide offline tray matches the local store UI.
  expect(globalHook.result.current).toEqual(storeHook.result.current);
  expect(globalEntity).toEqual(storeEntity);
  expect(getGlobalOfflineEntities(sessionKey)).toEqual(
    globalHook.result.current,
  );

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time | query-items                    |
    0    | Ada, Grace                     | ui-initialized
    12s  | Ada, Grace                     | -- queue a temp create and then edit the same temp item while still offline
    .    | Ada, Grace, Linus offline      | ui-changed
    .    | Ada, Grace, Linus offline      | offline:createUser queued
    .    | Ada, Grace, Linus blocked edit | ui-changed
    .    | Ada, Grace, Linus blocked edit | offline:patchUserName queued
    .    | Ada, Grace, Linus blocked edit | -- go back online and let replay exhaust every retry for the temp create
    .    | Ada, Grace, Linus blocked edit | offline:createUser replay-started
    17s  | Ada, Grace, Linus blocked edit | offline:createUser replay-started
    22s  | Ada, Grace, Linus blocked edit | offline:createUser replay-started
    .    | Ada, Grace, Linus blocked edit | offline:createUser resolution-required
    .    | Ada, Grace, Linus blocked edit | offline:patchUserName resolution-required
    "
  `);

  queryHook.unmount();
  storeHook.unmount();
  globalHook.unmount();
});

test('offline mutations fail fast when no session key is available', async () => {
  network.setOffline();
  const sessionKey: string | false = false;

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: { network: network.config },
    }),
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            execute: async ({ input }: UpdateValueExecuteContext) => {
              await env.serverMock.delayedSetData(input.value);
              return input;
            },
            onSuccessExecute: ({ input }) => {
              env.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
            },
          },
        },
      },
    },
  });

  await Promise.resolve();

  const mutationResult = await env.apiStore.performMutation({
    optimisticUpdate: () => {
      env.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: async () => {
      await env.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  expect(mutationResult.ok).toBe(false);

  expect(mutationResult.error).toMatchInlineSnapshot(
    `
      Error#:
        message: 'Offline session unavailable'
        name: 'StoreMutationError'
        kind: 'error'
        code: 460
        id: 'offline-session-unavailable'
        cause:
          Error#:
            message: 'Offline session unavailable'
            name: 'OfflineSessionUnavailableError'
            code: 460
            id: 'offline-session-unavailable'
    `,
  );
  expect(env.store.state.data).toMatchInlineSnapshot(`
    value: 1
  `);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
});
