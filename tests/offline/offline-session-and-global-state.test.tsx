import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  createOfflineSession,
  getGlobalOfflineEntities,
  getGlobalOfflineStatus,
  useGlobalOfflineEntities,
  useGlobalOfflineStatus,
} from '../../src/main';
import { readManagedLocalStorageSingleEntryByPayload } from '../../src/persistentStorage/localStorageMetadata';
import { __resetSessionOfflineCoordinatorRegistryForTests } from '../../src/persistentStorage/offline/sessionCoordinator';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { withSuppressedActError } from '../utils/withSuppressedActError';
import {
  type CreateListQueryUserOperations,
  getOfflineQueueEntries,
  getSortedSessionQueueSummary,
  type PatchUserOperations,
  type UpdateValueExecuteContext,
  type UpdateValueOperations,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  classifyRetryableReplayFailure,
  collectionCreateInputSchema,
  collectionSchema,
  docMutationInputSchema,
  docSchema,
  listQueryQueryPayloadSchema,
  parsePersistedObject,
  waitForMicrotaskCondition,
} from './offlineTestShared';

let network = createOfflineNetworkMock();

beforeEach(() => {
  __resetSessionOfflineCoordinatorRegistryForTests();
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  network = createOfflineNetworkMock();
  network.install();
  localStorage.clear();
});

afterEach(() => {
  __resetSessionOfflineCoordinatorRegistryForTests();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  localStorage.clear();
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

function getGlobalOfflineStatusSummary(sessionKey: string) {
  return pick(getGlobalOfflineStatus(sessionKey), [
    'isOfflineMode',
    'network',
    'outage',
    'sessionKey',
  ]);
}

// Protects against stale offline entities leaking after logout: when the session
// key becomes unavailable, the store must unregister from the previous session.
test('stores unregister their previous offline session when the session key becomes unavailable', async () => {
  network.setOffline();

  let currentSessionKey: string | false = 'offline-session-cleanup';
  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: 'offline-session-cleanup-doc',
    getSessionKey: () => currentSessionKey,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () => currentSessionKey,
          config: { network: network.config },
        }),
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
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
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () => currentSessionKey,
          config: { network: network.config },
        }),
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
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
    time  | ui                    |
    0     | "value:1 pending:no"  | ui-initialized
    .     | "value:2 pending:no"  | ui-changed
    .     | "value:2 pending:yes" | ui-changed
    .     | "value:2 pending:yes" | offline:updateValue queued
    .     | "value:2 pending:yes" | session-key-changed (from: offline-session-resume, to: false)
    .     | "value:2 pending:no"  | ui-changed
    10ms  | "value:2 pending:no"  | -- the browser goes back online while the app is logged out
    .     | "value:2 pending:no"  | 🔴 >fetch-started
    810ms | "value:2 pending:no"  | 🔴 <fetch-finished (value: 1)
    .     | "value:1 pending:no"  | ui-changed
    1.81s | "value:1 pending:no"  | -- the same session logs back in and triggers a normal online fetch
    .     | "value:1 pending:no"  | session-key-changed (from: false, to: offline-session-resume)
    .     | "value:1 pending:no"  | scheduled-fetch-triggered
    1.82s | "value:1 pending:yes" | ui-changed
    .     | "value:1 pending:yes" | 🟠 >fetch-started
    .     | "value:1 pending:yes" | offline:updateValue replay-started
    2.62s | "value:1 pending:yes" | 🟠 <fetch-finished (value: 1)
    3.02s | "value:1 pending:yes" | server-data-changed (value: 2)
    .     | "value:1 pending:yes" | offline:updateValue replay-finished
    .     | "value:2 pending:no"  | ui-changed
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
      testScenario: { loaded: { queries: [usersQuery] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => sessionKey,
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
    await env.apiStore.performMutation(null, {
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
    createdAt: 1735689613010
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
    updatedAt: 1735689613010
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
    time   | query-items                    |
    0      | Ada, Grace                     | ui-initialized
    3.01s  | Ada, Grace                     | -- queue a temp create and then edit the same temp item while still offline
    .      | Ada, Grace, Linus offline      | ui-changed
    .      | Ada, Grace, Linus offline      | offline:createUser queued
    .      | Ada, Grace, Linus blocked edit | ui-changed
    .      | Ada, Grace, Linus blocked edit | offline:patchUserName queued
    .      | Ada, Grace, Linus blocked edit | -- go back online and let replay exhaust every retry for the temp create
    .      | Ada, Grace, Linus blocked edit | offline:createUser replay-started
    8.01s  | Ada, Grace, Linus blocked edit | offline:createUser replay-started
    13.01s | Ada, Grace, Linus blocked edit | offline:createUser replay-started
    .      | Ada, Grace, Linus blocked edit | offline:createUser resolution-required
    .      | Ada, Grace, Linus blocked edit | offline:patchUserName resolution-required
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
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () => sessionKey,
          config: { network: network.config },
        }),
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
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
    `Error#: { message: 'Offline session unavailable', name: 'Error' }`,
  );
  expect(env.store.state.data).toMatchInlineSnapshot(`
    value: 1
  `);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
});

// The global offline hook should work even before any offline-enabled store is created,
// so apps can render a global offline banner unconditionally at mount time.
test('global offline hooks can mount before a localStorage-backed store', async () => {
  network.setOffline();
  const sessionKey = 'offline-global-hook-session';
  const storeName = 'offline-global-hook-doc';
  const offlineStatusKey = `tsdf.${sessionKey}._o_.s`;
  const globalStatusRenders = createLoggerStore();

  // Mount the global banner before any store has initialized offline support.
  const globalHook = renderHook(() => {
    const status = pick(useGlobalOfflineStatus(sessionKey), [
      'isOfflineMode',
      'network',
      'outage',
      'sessionKey',
    ]);

    globalStatusRenders.add(status);
    return status;
  });

  let env!: ReturnType<
    typeof createDocumentStoreTestEnv<number, UpdateValueOperations>
  >;
  let mutationOk = false;

  // Create the offline-enabled store after the global hook is already mounted.
  await act(async () => {
    env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => sessionKey,
            config: { network: network.config },
          }),
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
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

    // Let the store finish registering its offline session before the mutation.
    await Promise.resolve();

    // Queue a durable offline mutation so the session writes the canonical
    // compact status snapshot that a future app boot would rely on.
    mutationOk = (
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
      })
    ).ok;
    await Promise.resolve();
  });

  expect(mutationOk).toBe(true);
  expect(parsePersistedObject(localStorage.getItem(offlineStatusKey)!))
    .toMatchInlineSnapshot(`
      d:
        n: { a: 1, e: 1 }
        u: 1735689600000
    `);
  expect(globalStatusRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ isOfflineMode: ❌
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: offline-global-hook-session
    └─
    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: offline-global-hook-session
    └─
    "
  `);

  // Once the session is back online, the canonical status entry should remain
  // present but switch to a compact non-offline snapshot that cleanup can age out.
  globalStatusRenders.addMark('Browser reconnects');
  await act(async () => {
    network.goOnline();
    await waitForMicrotaskCondition(() => {
      const stored = localStorage.getItem(offlineStatusKey);
      if (stored === null) return false;

      const parsed = parsePersistedObject(stored);
      const status = parsed.d;
      return (
        status !== null &&
        typeof status === 'object' &&
        'n' in status &&
        typeof status.n === 'object' &&
        status.n !== null &&
        !('a' in status.n)
      );
    });
  });
  expect(parsePersistedObject(localStorage.getItem(offlineStatusKey)!))
    .toMatchInlineSnapshot(`
      d:
        n: { e: 1 }
        u: 1735689600000
    `);

  expect(globalStatusRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ isOfflineMode: ❌
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: offline-global-hook-session
    └─
    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: offline-global-hook-session
    └─
    ⋅⋅⋅
    >>> Browser reconnects

    ┌─
    ⋅ isOfflineMode: ❌
    ⋅ network: {enabled:✅, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: offline-global-hook-session
    └─
    "
  `);

  await advanceTime(1010);

  expect(
    readManagedLocalStorageSingleEntryByPayload(
      `tsdf.${sessionKey}.${storeName}`,
    ),
  ).toMatchInlineSnapshot(`
    lastAccessAt: 1735689601000
    meta: { o: '✅' }
    payloadKey: 'tsdf.offline-global-hook-session.offline-global-hook-doc'
  `);

  globalHook.unmount();
});

// After a restart, the app should recover the previous offline state from
// localStorage immediately instead of waiting for store hydration to confirm it.
test('app restart boots global offline status from the persisted localStorage snapshot', () => {
  const sessionKey = 'offline-startup-bootstrap';
  const statusKey = `tsdf.${sessionKey}._o_.s`;

  // Simulate the compact canonical status record left behind by a previous offline session.
  localStorage.setItem(
    statusKey,
    JSON.stringify({ d: { n: { e: 1, a: 1 }, u: TEST_INITIAL_TIME } }),
  );

  expect(parsePersistedObject(localStorage.getItem(statusKey)!))
    .toMatchInlineSnapshot(`
      d:
        n: { a: 1, e: 1 }
        u: 1735689600000
    `);

  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'offline-startup-bootstrap'
  `);

  const hook = renderHook(() =>
    pick(useGlobalOfflineStatus(sessionKey), [
      'isOfflineMode',
      'network',
      'outage',
      'sessionKey',
    ]),
  );

  expect(hook.result.current).toEqual(
    getGlobalOfflineStatusSummary(sessionKey),
  );

  hook.unmount();
});

// Multiple stores sharing the same session key should report a single, consistent
// global offline status so the app can rely on one source of truth.
test('global offline status is shared across stores in the same session', async () => {
  network.setOffline();
  const sessionKey = 'shared-offline-session';

  // The document store joins the shared session first.
  createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () => sessionKey,
          config: { network: { enabled: true } },
        }),
        operations: {},
      },
    },
  });

  // A different store type joining the same session should not create a second
  // global status stream; both stores must converge on the same session state.
  createCollectionStoreTestEnv(
    { 'users||1': { name: 'User 1' } },
    {
      getSessionKey: () => sessionKey,
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => sessionKey,
            config: { network: { enabled: true } },
          }),
          operations: {},
        },
      },
    },
  );

  await Promise.resolve();

  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    isLeader: '✅'
    isOfflineMode: '✅'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'shared-offline-session'
    updatedAt: 1735689600000
  `);
  const hook = renderHook(() =>
    pick(useGlobalOfflineStatus(sessionKey), [
      'isOfflineMode',
      'network',
      'outage',
      'sessionKey',
    ]),
  );
  expect(hook.result.current).toEqual(
    getGlobalOfflineStatusSummary(sessionKey),
  );
  hook.unmount();
});

test('stores sharing a session key reject incompatible offline session configs', () => {
  const sessionKey = 'incompatible-offline-session';
  const matchingSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: { network: { enabled: true } },
  });
  const incompatibleSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: {
      network: { enabled: true },
      outage: { enabled: true, recoveryCheck: () => false },
    },
  });

  createDocumentStoreTestEnv(1, {
    id: 'incompatible-offline-session-a',
    getSessionKey: () => sessionKey,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { session: matchingSession, operations: {} },
    },
  });

  expect(() =>
    incompatibleSession.getOfflineRuntimeConfig(),
  ).toThrowErrorMatchingInlineSnapshot(
    `
    Error#:
      message: '[tsdf] Incompatible offline session configuration for session "incompatible-offline-session"'
      name: 'Error'
    `,
  );
});

// Verifies that global selectors aggregate offline entities from all stores in the
// session, while per-store selectors only report that store's own queued mutations.
test('global and per-store offline entity selectors aggregate queued work across stores in the same session', async () => {
  network.setOffline();
  const sessionKey = 'shared-offline-entities';
  const pendingReplay = new Promise<{ value: number }>(() => {});

  function createEnv(storeName: string) {
    const env: ReturnType<
      typeof createDocumentStoreTestEnv<number, UpdateValueOperations>
    > = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => sessionKey,
            config: { network: network.config },
          }),
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: (_ctx_: UpdateValueExecuteContext) =>
                pendingReplay.then(async (result) => {
                  await env.serverMock.delayedSetData(result.value);
                  return result;
                }),
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
    return env;
  }

  const envA = createEnv('offline-doc-a');
  const envB = createEnv('offline-doc-b');
  await Promise.resolve();

  // Both stores observe the browser disconnect before they queue work.
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  // Queue work in the first store.
  await envA.apiStore.performMutation({
    optimisticUpdate: () => {
      envA.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: async () => {
      await envA.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  // Queue work in the second store; the global selector should now include both.
  await envB.apiStore.performMutation({
    optimisticUpdate: () => {
      envB.apiStore.updateState((draft) => {
        draft.value = 3;
      });
    },
    mutation: async () => {
      await envB.serverMock.delayedSetData(3);
      return 3;
    },
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  expect(getGlobalOfflineEntities(sessionKey)).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: 'document'
      entityKind: 'document'
      id: 'shared-offline-entities:offline-doc-a:document'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'shared-offline-entities'
      storeName: 'offline-doc-a'
      storeType: 'document'
      syncState: 'pending'
      updatedAt: 1735689600000
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: 'document'
      entityKind: 'document'
      id: 'shared-offline-entities:offline-doc-b:document'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'shared-offline-entities'
      storeName: 'offline-doc-b'
      storeType: 'document'
      syncState: 'pending'
      updatedAt: 1735689600000
  `);
  const globalHook = renderHook(() => useGlobalOfflineEntities(sessionKey));
  expect(globalHook.result.current).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: 'document'
      entityKind: 'document'
      id: 'shared-offline-entities:offline-doc-a:document'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'shared-offline-entities'
      storeName: 'offline-doc-a'
      storeType: 'document'
      syncState: 'pending'
      updatedAt: 1735689600000
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: 'document'
      entityKind: 'document'
      id: 'shared-offline-entities:offline-doc-b:document'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'shared-offline-entities'
      storeName: 'offline-doc-b'
      storeType: 'document'
      syncState: 'pending'
      updatedAt: 1735689600000
  `);
  const storeHook = renderHook(() => envA.apiStore.useOfflineEntities());
  expect(storeHook.result.current).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: 'document'
      entityKind: 'document'
      id: 'shared-offline-entities:offline-doc-a:document'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'shared-offline-entities'
      storeName: 'offline-doc-a'
      storeType: 'document'
      syncState: 'pending'
      updatedAt: 1735689600000
  `);
  globalHook.unmount();
  storeHook.unmount();
});

test('queued mutations from multiple stores in one session share a single global replay order', async () => {
  network.setOffline();
  const sessionKey = 'shared-session-queue-order';
  const offlineSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: { network: network.config },
  });

  function createEnv(storeName: string) {
    const env: ReturnType<
      typeof createDocumentStoreTestEnv<number, UpdateValueOperations>
    > = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          session: offlineSession,
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
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

    return env;
  }

  const envA = createEnv('shared-session-queue-order-a');
  const envB = createEnv('shared-session-queue-order-b');
  await Promise.resolve();

  // Both stores first observe the same offline transition before they queue
  // durable work into the shared session.
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  // Queue the first store's mutation.
  await envA.apiStore.performMutation({
    optimisticUpdate: () => {
      envA.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: async () => {
      await envA.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  // Advance time so the second store gets a later replay position.
  await advanceTime(50);

  // Queue the second store's mutation afterwards.
  await envB.apiStore.performMutation({
    optimisticUpdate: () => {
      envB.apiStore.updateState((draft) => {
        draft.value = 3;
      });
    },
    mutation: async () => {
      await envB.serverMock.delayedSetData(3);
      return 3;
    },
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  // The persisted session view should read like one queue ordered by enqueue
  // time, even though each store still persists its own namespace entries.
  expect(getSortedSessionQueueSummary(sessionKey)).toMatchInlineSnapshot(`
    - input: { value: 2 }
      operation: 'updateValue'
      storeName: 'shared-session-queue-order-a'
      storeType: 'document'
    - input: { value: 3 }
      operation: 'updateValue'
      storeName: 'shared-session-queue-order-b'
      storeType: 'document'
  `);
});

test('reconnect replays queued mutations from multiple stores one at a time in global enqueue order', async () => {
  network.setOffline();
  const sessionKey = 'shared-session-replay-order';
  const offlineSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: { network: network.config },
  });
  const replayLog: string[] = [];
  let releaseFirstReplay: (() => void) | null = null;

  function createEnv(args: { storeName: string; shouldBlockReplay?: boolean }) {
    const env: ReturnType<
      typeof createDocumentStoreTestEnv<number, UpdateValueOperations>
    > = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: args.storeName,
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          session: offlineSession,
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: async ({ input }: UpdateValueExecuteContext) => {
                replayLog.push(`${args.storeName}:start:${input.value}`);

                if (args.shouldBlockReplay) {
                  await new Promise<void>((resolve) => {
                    releaseFirstReplay = resolve;
                  });
                }

                await env.serverMock.delayedSetData(input.value);
                replayLog.push(`${args.storeName}:finish:${input.value}`);
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

    return env;
  }

  const envA = createEnv({
    storeName: 'shared-session-replay-order-a',
    shouldBlockReplay: true,
  });
  const envB = createEnv({ storeName: 'shared-session-replay-order-b' });
  await Promise.resolve();

  // Both stores must observe the same offline session before queueing work.
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  // Queue the earliest replay candidate in the first store.
  envA.addTimelineComments('beforeNextAction', [
    'queue the first store mutation while the session is offline',
  ]);
  await envA.apiStore.performMutation({
    optimisticUpdate: () => {
      envA.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: async () => {
      await envA.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  // Give the second mutation a later queue position so the intended order is
  // unambiguous in both the persisted queue and the replay log.
  await advanceTime(50);

  // Queue the second store's mutation behind the first one.
  envB.addTimelineComments('beforeNextAction', [
    'queue the second store mutation behind the first one',
  ]);
  await envB.apiStore.performMutation({
    optimisticUpdate: () => {
      envB.apiStore.updateState((draft) => {
        draft.value = 3;
      });
    },
    mutation: async () => {
      await envB.serverMock.delayedSetData(3);
      return 3;
    },
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  expect(getSortedSessionQueueSummary(sessionKey)).toMatchInlineSnapshot(`
    - input: { value: 2 }
      operation: 'updateValue'
      storeName: 'shared-session-replay-order-a'
      storeType: 'document'
    - input: { value: 3 }
      operation: 'updateValue'
      storeName: 'shared-session-replay-order-b'
      storeType: 'document'
  `);

  // Reconnect the shared session. The first replay may start, but the second
  // store must stay queued until that earlier work fully completes.
  envA.addTimelineComments('beforeNextAction', [
    'reconnect the session and let the earliest queued mutation start replaying',
  ]);
  envB.addTimelineComments('beforeNextAction', [
    'reconnect the session and wait for the earlier queued mutation to finish first',
  ]);
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await waitForMicrotaskCondition(() => replayLog.length > 0);

  // Before the first replay is released, only the earliest queued mutation
  // should have started.
  expect(replayLog).toMatchInlineSnapshot(`
    ['shared-session-replay-order-a:start:2']
  `);

  // Once the first replay finishes, the second store can take the next turn.
  await act(async () => {
    releaseFirstReplay?.();
    await flushAllTimers();
  });
  await waitForMicrotaskCondition(() => replayLog.length === 4);

  // The replay log should now read like one shared queue drained in order.
  expect(replayLog).toMatchInlineSnapshot(`
    - 'shared-session-replay-order-a:start:2'
    - 'shared-session-replay-order-a:finish:2'
    - 'shared-session-replay-order-b:start:3'
    - 'shared-session-replay-order-b:finish:3'
  `);
  expect(
    getOfflineQueueEntries(sessionKey, 'shared-session-replay-order-a'),
  ).toMatchInlineSnapshot(`[]`);
  expect(
    getOfflineQueueEntries(sessionKey, 'shared-session-replay-order-b'),
  ).toMatchInlineSnapshot(`[]`);
  expect({ storeA: envA.timelineString, storeB: envB.timelineString })
    .toMatchInlineSnapshot(`
    storeA: |

      time  |
      0     | -- queue the first store mutation while the session is offline
      .     | offline:updateValue queued
      50ms  | -- reconnect the session and let the earliest queued mutation start replaying
      .     | offline:updateValue replay-started
      1.25s | server-data-changed (value: 2)
      .     | offline:updateValue replay-finished
    storeB: |

      time  |
      50ms  | -- queue the second store mutation behind the first one
      .     | offline:updateValue queued
      1.25s | -- reconnect the session and wait for the earlier queued mutation to finish first
      .     | offline:updateValue replay-started
      2.45s | server-data-changed (value: 3)
      .     | offline:updateValue replay-finished
  `);
});

test('a store initialized while an earlier shared-session replay is already in flight waits for its turn', async () => {
  network.setOffline();
  const sessionKey = 'shared-session-mid-replay-init';
  const replayLog: string[] = [];
  let hasReleaseFirstReplay = false;
  let releaseFirstReplay: () => void = () => {
    throw new Error('Expected the first replay to be waiting for release');
  };

  function createEnv(args: {
    storeName: string;
    testScenario?: 'idle' | 'loaded';
    onExecute?: (input: { value: number }) => Promise<void> | void;
  }) {
    const env: ReturnType<
      typeof createDocumentStoreTestEnv<number, UpdateValueOperations>
    > = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: args.storeName,
      getSessionKey: () => sessionKey,
      testScenario: args.testScenario ?? 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => sessionKey,
            config: { network: network.config },
          }),
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: async ({ input }: UpdateValueExecuteContext) => {
                replayLog.push(`${args.storeName}:start:${input.value}`);
                await args.onExecute?.(input);
                await env.serverMock.delayedSetData(input.value);
                replayLog.push(`${args.storeName}:finish:${input.value}`);
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

    return env;
  }

  // Seed durable queue entries for both stores before the replaying session
  // exists, matching a real restart with persisted offline work.
  const seededEnvA = createEnv({
    storeName: 'shared-session-mid-replay-init-a',
    testScenario: 'loaded',
  });
  const seededEnvB = createEnv({
    storeName: 'shared-session-mid-replay-init-b',
    testScenario: 'loaded',
  });
  await Promise.resolve();

  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  await seededEnvA.apiStore.performMutation({
    optimisticUpdate: () => {
      seededEnvA.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: async () => {
      await seededEnvA.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  await advanceTime(50);

  await seededEnvB.apiStore.performMutation({
    optimisticUpdate: () => {
      seededEnvB.apiStore.updateState((draft) => {
        draft.value = 3;
      });
    },
    mutation: async () => {
      await seededEnvB.serverMock.delayedSetData(3);
      return 3;
    },
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  expect(getSortedSessionQueueSummary(sessionKey)).toMatchInlineSnapshot(`
    - input: { value: 2 }
      operation: 'updateValue'
      storeName: 'shared-session-mid-replay-init-a'
      storeType: 'document'
    - input: { value: 3 }
      operation: 'updateValue'
      storeName: 'shared-session-mid-replay-init-b'
      storeType: 'document'
  `);

  // Reboot into a fresh browser session that starts online.
  __resetSessionOfflineCoordinatorRegistryForTests();
  act(() => {
    network.goOnline();
  });

  // Start only the earliest queued store first and block its execute so replay
  // stays in-flight while the later store is initialized.
  const restartedEnvA = createEnv({
    storeName: 'shared-session-mid-replay-init-a',
    testScenario: 'idle',
    onExecute: async () => {
      await new Promise<void>((resolve) => {
        hasReleaseFirstReplay = true;
        releaseFirstReplay = resolve;
      });
    },
  });
  const restartedHookA = renderHook(() =>
    restartedEnvA.apiStore.useDocument({ returnRefetchingStatus: true }),
  );
  restartedEnvA.addTimelineComments('beforeNextAction', [
    'the restarted session boots online and begins replaying the earliest queued store',
  ]);
  await withSuppressedActError(async () => {
    await flushAllTimers();
    await waitForMicrotaskCondition(() => replayLog.length === 1);
  });

  expect(replayLog).toMatchInlineSnapshot(`
    ['shared-session-mid-replay-init-a:start:2']
  `);

  // Initializing the later store mid-replay must not start its queued entry
  // until the earlier replay has fully completed.
  const restartedEnvB = createEnv({
    storeName: 'shared-session-mid-replay-init-b',
    testScenario: 'idle',
  });
  const restartedHookB = renderHook(() =>
    restartedEnvB.apiStore.useDocument({ returnRefetchingStatus: true }),
  );
  restartedEnvB.addTimelineComments('beforeNextAction', [
    'the later store initializes while the first replay is still in flight',
  ]);
  await withSuppressedActError(async () => {
    await flushAllTimers();
    await Promise.resolve();
  });

  expect(replayLog).toMatchInlineSnapshot(`
    ['shared-session-mid-replay-init-a:start:2']
  `);

  // Releasing the first execute is not enough on its own; the second store
  // still has to wait for the first replay to finish writing its server result.
  expect(hasReleaseFirstReplay).toBe(true);
  releaseFirstReplay();
  await Promise.resolve();
  await Promise.resolve();

  expect(replayLog).toMatchInlineSnapshot(`
    ['shared-session-mid-replay-init-a:start:2']
  `);

  await withSuppressedActError(async () => {
    await flushAllTimers();
    await waitForMicrotaskCondition(() => replayLog.length === 4);
  });

  expect(replayLog).toMatchInlineSnapshot(`
    - 'shared-session-mid-replay-init-a:start:2'
    - 'shared-session-mid-replay-init-a:finish:2'
    - 'shared-session-mid-replay-init-b:start:3'
    - 'shared-session-mid-replay-init-b:finish:3'
  `);
  expect(
    getOfflineQueueEntries(sessionKey, 'shared-session-mid-replay-init-a'),
  ).toMatchInlineSnapshot(`[]`);
  expect(
    getOfflineQueueEntries(sessionKey, 'shared-session-mid-replay-init-b'),
  ).toMatchInlineSnapshot(`[]`);
  expect({
    storeA: restartedEnvA.timelineString,
    storeB: restartedEnvB.timelineString,
  }).toMatchInlineSnapshot(`
    storeA: |

      time  |
      10ms  | -- the restarted session boots online and begins replaying the earliest queued store
      .     | 🔴 >fetch-started
      .     | offline:updateValue replay-started
      810ms | 🔴 <fetch-finished (value: 1)
      5.2s  | server-data-changed (value: 2)
      .     | offline:updateValue replay-finished
    storeB: |

      time  |
      10ms  | -- the later store initializes while the first replay is still in flight
      .     | 🔴 >fetch-started
      810ms | 🔴 <fetch-finished (value: 1)
      3.2s  | offline:updateValue replay-started
      4.4s  | server-data-changed (value: 3)
      .     | offline:updateValue replay-finished
  `);

  restartedHookA.unmount();
  restartedHookB.unmount();
});
