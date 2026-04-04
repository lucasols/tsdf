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
import { createOfflineConfigForSessionKey } from '../utils/offlineConfig';
import {
  type CreateListQueryUserOperations,
  getOfflineQueueEntries,
  type PatchUserOperations,
  type UpdateValueOperations,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import {
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
      'effectiveMode',
      'effectiveOffline',
      'isLeader',
      'lastFailureAt',
      'lastRecoveryCheckAt',
      'network',
      'outage',
      'sessionKey',
    ]),
  ).toMatchInlineSnapshot(`
    effectiveMode: 'online'
    effectiveOffline: '❌'
    isLeader: '✅'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'offline-opt-in-required'
  `);
});

function pickGlobalOfflineStatusSummary(
  status: ReturnType<typeof getGlobalOfflineStatus> | null | undefined,
) {
  return pick(status, [
    'effectiveMode',
    'effectiveOffline',
    'network',
    'outage',
    'sessionKey',
  ]);
}

function getGlobalOfflineStatusSummary(sessionKey: string) {
  return pickGlobalOfflineStatusSummary(getGlobalOfflineStatus(sessionKey));
}

type UpdateValueExecuteContext = Parameters<
  UpdateValueOperations['updateValue']['execute']
>[0];

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
      offline: createOfflineConfigForSessionKey(() => currentSessionKey, {
        network: network.config,
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            execute: ({ input }: UpdateValueExecuteContext) => input,
          },
        },
      }),
    },
  });

  await act(async () => {
    await env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: () => Promise.resolve(2),
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
      offline: createOfflineConfigForSessionKey(() => currentSessionKey, {
        network: network.config,
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            execute: ({ input }: UpdateValueExecuteContext) => {
              replayedInputs.push(input);
              env.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
              return input;
            },
          },
        },
      }),
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
      mutation: () => Promise.resolve(2),
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
    .     | "value:1 pending:yes" | offline:updateValue replay-finished
    .     | "value:2 pending:yes" | ui-changed
    .     | "value:2 pending:no"  | ui-changed
    2.62s | "value:2 pending:no"  | 🟠 <fetch-finished (value: 1)
    .     | "value:1 pending:no"  | ui-changed
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
        offline: createOfflineConfigForSessionKey(() => sessionKey, {
          network: network.config,
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
              execute: ({ input }) => ({ name: input.name }),
            },
          },
        }),
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
  for (const attempt of [2, 3, 4, 5]) {
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
    createdAt: 1735689623010
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
    updatedAt: 1735689623010
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
    18.01s | Ada, Grace, Linus blocked edit | offline:createUser replay-started
    23.01s | Ada, Grace, Linus blocked edit | offline:createUser replay-started
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
      offline: createOfflineConfigForSessionKey(() => sessionKey, {
        network: network.config,
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            execute: ({ input }: UpdateValueExecuteContext) => {
              env.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
              return input;
            },
          },
        },
      }),
    },
  });

  await Promise.resolve();

  const mutationResult = await env.apiStore.performMutation({
    optimisticUpdate: () => {
      env.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: () => Promise.resolve(2),
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
  const offlineBootstrapKey = `tsdf-os:${sessionKey}`;
  const globalStatusRenders = createLoggerStore();

  // Mount the global banner before any store has initialized offline support.
  const globalHook = renderHook(() => {
    const status = pick(useGlobalOfflineStatus(sessionKey), [
      'effectiveMode',
      'effectiveOffline',
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
        offline: createOfflineConfigForSessionKey(() => sessionKey, {
          network: network.config,
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: ({ input }: UpdateValueExecuteContext) => {
                env.apiStore.updateState((draft) => {
                  draft.value = input.value;
                });
                return input;
              },
            },
          },
        }),
      },
    });

    // Let the store finish registering its offline session before the mutation.
    await Promise.resolve();

    // Queue a durable offline mutation so the session writes the startup
    // bootstrap snapshot that a future app boot would rely on.
    mutationOk = (
      await env.apiStore.performMutation({
        optimisticUpdate: () => {
          env.apiStore.updateState((draft) => {
            draft.value = 2;
          });
        },
        mutation: () => Promise.resolve(2),
        offline: { operation: 'updateValue', input: { value: 2 } },
      })
    ).ok;
    await Promise.resolve();
  });

  expect(mutationOk).toBe(true);
  expect(parsePersistedObject(localStorage.getItem(offlineBootstrapKey)!))
    .toMatchInlineSnapshot(`
      d:
        n: { a: 1, e: 1 }
        s: 'offline-global-hook-session'
        u: 1735689600000
    `);
  expect(globalStatusRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ effectiveMode: online
    ⋅ effectiveOffline: ❌
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: offline-global-hook-session
    └─
    ┌─
    ⋅ effectiveMode: offline
    ⋅ effectiveOffline: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: offline-global-hook-session
    └─
    "
  `);

  // Once the session is back online, the startup bootstrap snapshot should be
  // cleared so future boots do not resurrect a stale offline state.
  globalStatusRenders.addMark('Browser reconnects');
  await act(async () => {
    network.goOnline();
    await waitForMicrotaskCondition(
      () => localStorage.getItem(offlineBootstrapKey) === null,
    );
  });
  expect(localStorage.getItem(offlineBootstrapKey)).toBeNull();

  expect(globalStatusRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ effectiveMode: online
    ⋅ effectiveOffline: ❌
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: offline-global-hook-session
    └─
    ┌─
    ⋅ effectiveMode: offline
    ⋅ effectiveOffline: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: offline-global-hook-session
    └─
    ⋅⋅⋅
    >>> Browser reconnects

    ┌─
    ⋅ effectiveMode: online
    ⋅ effectiveOffline: ❌
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
  const bootstrapKey = `tsdf-os:${sessionKey}`;

  // Simulate the bootstrap record left behind by a previous offline session.
  localStorage.setItem(
    bootstrapKey,
    JSON.stringify({
      d: { s: sessionKey, n: { e: 1, a: 1 }, u: TEST_INITIAL_TIME },
    }),
  );

  expect(parsePersistedObject(localStorage.getItem(bootstrapKey)!))
    .toMatchInlineSnapshot(`
      d:
        n: { a: 1, e: 1 }
        s: 'offline-startup-bootstrap'
        u: 1735689600000
    `);

  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'offline-startup-bootstrap'
  `);

  const hook = renderHook(() =>
    pickGlobalOfflineStatusSummary(useGlobalOfflineStatus(sessionKey)),
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
      offline: createOfflineConfigForSessionKey(() => sessionKey, {
        network: { enabled: true },
        operations: {},
      }),
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
        offline: createOfflineConfigForSessionKey(() => sessionKey, {
          network: { enabled: true },
          operations: {},
        }),
      },
    },
  );

  await Promise.resolve();

  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    isLeader: '✅'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'shared-offline-session'
    updatedAt: 1735689600000
  `);
  const hook = renderHook(() =>
    pickGlobalOfflineStatusSummary(useGlobalOfflineStatus(sessionKey)),
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

test('runtime mode enabled toggles are shared across stores in the same session', async () => {
  network.setOffline();
  const sessionKey = 'shared-runtime-offline-controls';
  const usersQuery = { tableId: 'users' } as const;
  const sharedOutageRecoveryCheck = () => false;
  const statusRenders = createLoggerStore();
  const offlineSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: {
      network: network.config,
      outage: { enabled: true, recoveryCheck: sharedOutageRecoveryCheck },
    },
  });

  // Each store type should read and mutate the same runtime controls.
  createDocumentStoreTestEnv(1, {
    id: 'shared-runtime-doc',
    getSessionKey: () => sessionKey,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { session: offlineSession, operations: {} },
    },
  });

  createCollectionStoreTestEnv(
    { 'users||1': { name: 'User 1' } },
    {
      id: 'shared-runtime-collection',
      getSessionKey: () => sessionKey,
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: { session: offlineSession, operations: {} },
      },
    },
  );

  createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      id: 'shared-runtime-list-query',
      getSessionKey: () => sessionKey,
      testScenario: { loaded: { queries: [usersQuery] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: { session: offlineSession, operations: {} },
      },
    },
  );

  await Promise.resolve();
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  expect(offlineSession.getOfflineRuntimeConfig()).toMatchInlineSnapshot(`
    mutationQueueing: { network: 'allow', outage: 'allow' }
    network: { enabled: '✅' }
    outage: { enabled: '✅' }
  `);

  // Disabling both modes should immediately move the shared session back online.
  statusRenders.addMark('Disable runtime offline modes');
  offlineSession.setOfflineRuntimeConfig({
    network: { enabled: false },
    outage: { enabled: false },
  });
  await Promise.resolve();

  expect(offlineSession.getOfflineRuntimeConfig()).toMatchInlineSnapshot(`
    mutationQueueing: { network: 'allow', outage: 'allow' }
    network: { enabled: '❌' }
    outage: { enabled: '❌' }
  `);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'online'
    effectiveOffline: '❌'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'shared-runtime-offline-controls'
  `);
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  // Re-enabling the runtime controls should restore the same shared offline session.
  statusRenders.addMark('Re-enable runtime offline modes');
  offlineSession.setOfflineRuntimeConfig({
    network: { enabled: true },
    outage: { enabled: true },
  });
  await Promise.resolve();

  expect(offlineSession.getOfflineRuntimeConfig()).toMatchInlineSnapshot(`
    mutationQueueing: { network: 'allow', outage: 'allow' }
    network: { enabled: '✅' }
    outage: { enabled: '✅' }
  `);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '✅' }
    sessionKey: 'shared-runtime-offline-controls'
  `);
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));
  expect(statusRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ effectiveMode: offline
    ⋅ effectiveOffline: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: shared-runtime-offline-controls
    └─

    >>> Disable runtime offline modes

    ┌─
    ⋅ effectiveMode: online
    ⋅ effectiveOffline: ❌
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: shared-runtime-offline-controls
    └─

    >>> Re-enable runtime offline modes

    ┌─
    ⋅ effectiveMode: offline
    ⋅ effectiveOffline: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:✅, active:❌}
    ⋅ sessionKey: shared-runtime-offline-controls
    └─
    "
  `);
});

test('runtime offline overrides are memory-only and reset to the store config after restart', async () => {
  network.setOffline();
  const sessionKey = 'memory-only-runtime-offline-controls';
  const firstOfflineSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: { network: network.config },
  });

  // First boot: disable runtime network mode only in memory.
  createDocumentStoreTestEnv(1, {
    id: 'memory-only-runtime-doc',
    getSessionKey: () => sessionKey,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { session: firstOfflineSession, operations: {} },
    },
  });

  await Promise.resolve();
  firstOfflineSession.setOfflineRuntimeConfig({
    network: { enabled: false },
    mutationQueueing: { network: 'disallow' },
  });
  await Promise.resolve();

  expect(firstOfflineSession.getOfflineRuntimeConfig()).toMatchInlineSnapshot(`
    mutationQueueing: { network: 'disallow', outage: 'allow' }
    network: { enabled: '❌' }
    outage: { enabled: '❌' }
  `);

  // Simulate a fresh app boot with the same persisted storage but a new runtime session.
  __resetSessionOfflineCoordinatorRegistryForTests();
  const restartedOfflineSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: { network: network.config },
  });

  createDocumentStoreTestEnv(1, {
    id: 'memory-only-runtime-doc',
    getSessionKey: () => sessionKey,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { session: restartedOfflineSession, operations: {} },
    },
  });

  await Promise.resolve();

  expect(restartedOfflineSession.getOfflineRuntimeConfig())
    .toMatchInlineSnapshot(`
      mutationQueueing: { network: 'allow', outage: 'allow' }
      network: { enabled: '✅' }
      outage: { enabled: '❌' }
    `);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'memory-only-runtime-offline-controls'
  `);
});

test('offline sessions follow dynamic session key changes and keep runtime overrides scoped per session key', () => {
  let currentSessionKey: string | false = 'dynamic-offline-session-a';
  const runtimeConfigRenders = createLoggerStore();
  const offlineSession = createOfflineSession({
    getSessionKey: () => currentSessionKey,
    config: { network: { enabled: true } },
  });

  runtimeConfigRenders.add(offlineSession.getOfflineRuntimeConfig());

  // Session A disables network mode for itself.
  offlineSession.setOfflineRuntimeConfig({ network: { enabled: false } });
  runtimeConfigRenders.add(offlineSession.getOfflineRuntimeConfig());

  // A different session key should see the default runtime config.
  runtimeConfigRenders.addMark('Switch to session B');
  currentSessionKey = 'dynamic-offline-session-b';
  runtimeConfigRenders.add(offlineSession.getOfflineRuntimeConfig());

  // Switching back should restore session A's previous in-memory override.
  runtimeConfigRenders.addMark('Switch back to session A');
  currentSessionKey = 'dynamic-offline-session-a';
  runtimeConfigRenders.add(offlineSession.getOfflineRuntimeConfig());

  expect(runtimeConfigRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ network: {enabled:✅}
    ⋅ outage: {enabled:❌}
    ⋅ mutationQueueing: {network:allow, outage:allow}
    └─
    ┌─
    ⋅ network: {enabled:❌}
    ⋅ outage: {enabled:❌}
    ⋅ mutationQueueing: {network:allow, outage:allow}
    └─

    >>> Switch to session B

    ┌─
    ⋅ network: {enabled:✅}
    ⋅ outage: {enabled:❌}
    ⋅ mutationQueueing: {network:allow, outage:allow}
    └─

    >>> Switch back to session A

    ┌─
    ⋅ network: {enabled:❌}
    ⋅ outage: {enabled:❌}
    ⋅ mutationQueueing: {network:allow, outage:allow}
    └─
    "
  `);
});

test('disabling active network mode pauses replay until network is re-enabled and connectivity recovers', async () => {
  network.setOffline();
  const sessionKey = 'runtime-network-replay-pause';
  const storeName = 'runtime-network-replay-pause-doc';
  const replayedInputs: { value: number }[] = [];
  const statusRenders = createLoggerStore();
  const offlineSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: { network: network.config },
  });

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
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
            execute: ({ input }: UpdateValueExecuteContext) => {
              replayedInputs.push(input);
              env.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
              return input;
            },
          },
        },
      },
    },
  });

  await Promise.resolve();
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  // Notify the already-mounted session that the browser went offline.
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  // Queue an offline mutation that replay would normally flush on reconnect.
  env.addTimelineComments('beforeNextAction', [
    'queue an offline mutation while network mode is active',
  ]);
  await env.apiStore.performMutation({
    optimisticUpdate: () => {
      env.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: () => Promise.resolve(2),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);

  // Disabling runtime network mode should pause replay even though the queue exists.
  offlineSession.setOfflineRuntimeConfig({ network: { enabled: false } });
  await Promise.resolve();

  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'online'
    effectiveOffline: '❌'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'runtime-network-replay-pause'
  `);
  statusRenders.addMark('Disable runtime network mode');
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  // While network mode is disabled, new offline-enabled mutations should use
  // the direct path instead of entering the durable queue.
  const directMutationWhileDisabled = vi.fn(() => Promise.resolve(3));
  const disabledNetworkMutationResult = await env.apiStore.performMutation({
    mutation: directMutationWhileDisabled,
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  expect({
    ok: disabledNetworkMutationResult.ok,
    value: disabledNetworkMutationResult.ok
      ? disabledNetworkMutationResult.value
      : null,
  }).toMatchInlineSnapshot(`
    ok: '✅'
    value: { data: 3, kind: 'online' }
  `);
  expect(directMutationWhileDisabled).toHaveBeenCalledTimes(1);

  await advanceTime(250);
  expect(replayedInputs).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);

  // Re-enabling network mode should restore offline status until connectivity returns.
  offlineSession.setOfflineRuntimeConfig({ network: { enabled: true } });
  await Promise.resolve();

  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'runtime-network-replay-pause'
  `);
  statusRenders.addMark('Re-enable runtime network mode');
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  // Connectivity recovery should finally replay the queued mutation.
  act(() => {
    network.goOnline();
  });
  await waitForMicrotaskCondition(() => replayedInputs.length === 1);
  statusRenders.addMark('Browser reconnects');
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  expect(replayedInputs).toMatchInlineSnapshot(`
    - value: 2
  `);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  await flushAllTimers();
  expect(statusRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ effectiveMode: offline
    ⋅ effectiveOffline: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-network-replay-pause
    └─

    >>> Disable runtime network mode

    ┌─
    ⋅ effectiveMode: online
    ⋅ effectiveOffline: ❌
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-network-replay-pause
    └─

    >>> Re-enable runtime network mode

    ┌─
    ⋅ effectiveMode: offline
    ⋅ effectiveOffline: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-network-replay-pause
    └─

    >>> Browser reconnects

    ┌─
    ⋅ effectiveMode: online
    ⋅ effectiveOffline: ❌
    ⋅ network: {enabled:✅, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-network-replay-pause
    └─
    "
  `);
});

test('disabling active outage mode pauses replay until outage is re-enabled and recovery succeeds', async () => {
  const sessionKey = 'runtime-outage-replay-pause';
  const storeName = 'runtime-outage-replay-pause-doc';
  const replayedInputs: { value: number }[] = [];
  const statusRenders = createLoggerStore();
  let recoveryAttempts = 0;
  const recoveryCheck = vi.fn(() => {
    recoveryAttempts += 1;
    return recoveryAttempts >= 2;
  });
  const offlineSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: {
      classifyFailure: () => 'outage' as const,
      outage: {
        enabled: true,
        recoveryCheck,
        recoveryProbe: {
          initialIntervalMs: 100,
          maxIntervalMs: 100,
          backoffMultiplier: 1,
          jitterRatio: 0,
        },
      },
    },
  });

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
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
            execute: ({ input }: UpdateValueExecuteContext) => {
              replayedInputs.push(input);
              env.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
              return input;
            },
          },
        },
      },
    },
  });

  // The initial mutation fails with an outage classification, so it queues for replay.
  const fallbackResult = await env.apiStore.performMutation({
    optimisticUpdate: () => {
      env.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: () => Promise.reject(new Error('outage fallback')),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));
  expect(fallbackResult.ok).toBe(true);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'runtime-outage-replay-pause'
  `);

  // Disabling runtime outage mode should stop the recovery probe loop entirely.
  offlineSession.setOfflineRuntimeConfig({ outage: { enabled: false } });
  await Promise.resolve();
  await advanceTime(250);

  expect(recoveryCheck).toHaveBeenCalledTimes(0);
  expect(replayedInputs).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'online'
    effectiveOffline: '❌'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'runtime-outage-replay-pause'
  `);
  statusRenders.addMark('Disable runtime outage mode');
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  // Re-enabling outage mode should restore the probe loop from the queued state.
  offlineSession.setOfflineRuntimeConfig({ outage: { enabled: true } });
  await Promise.resolve();

  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'runtime-outage-replay-pause'
  `);
  statusRenders.addMark('Re-enable runtime outage mode');
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  await advanceTime(100);
  expect(recoveryCheck).toHaveBeenCalledTimes(1);
  expect(replayedInputs).toMatchInlineSnapshot(`[]`);

  await advanceTime(100);
  await waitForMicrotaskCondition(() => replayedInputs.length === 1);
  statusRenders.addMark('Recovery succeeds');
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  expect(recoveryCheck).toHaveBeenCalledTimes(2);
  expect(replayedInputs).toMatchInlineSnapshot(`
    - value: 2
  `);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  expect(statusRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ effectiveMode: offline
    ⋅ effectiveOffline: ✅
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:✅, active:✅}
    ⋅ sessionKey: runtime-outage-replay-pause
    └─

    >>> Disable runtime outage mode

    ┌─
    ⋅ effectiveMode: online
    ⋅ effectiveOffline: ❌
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-outage-replay-pause
    └─

    >>> Re-enable runtime outage mode

    ┌─
    ⋅ effectiveMode: offline
    ⋅ effectiveOffline: ✅
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:✅, active:✅}
    ⋅ sessionKey: runtime-outage-replay-pause
    └─

    >>> Recovery succeeds

    ┌─
    ⋅ effectiveMode: online
    ⋅ effectiveOffline: ❌
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:✅, active:❌}
    ⋅ sessionKey: runtime-outage-replay-pause
    └─
    "
  `);
});

test('runtime mutation queueing overrides are shared across stores in the same session and affect only future mutations', async () => {
  network.setOffline();
  const sessionKey = 'runtime-mutation-queueing-overrides';
  const offlineSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: { network: network.config },
  });

  function createEnv(storeName: string) {
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
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
              execute: ({ input }: UpdateValueExecuteContext) => input,
            },
          },
        },
      },
    });
    return env;
  }

  const envA = createEnv('runtime-mutation-queueing-a');
  const envB = createEnv('runtime-mutation-queueing-b');
  await Promise.resolve();

  // Both stores observe the same offline session once the browser disconnects.
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  // The first mutation is queued before runtime queueing rules change.
  const firstResult = await envA.apiStore.performMutation({
    optimisticUpdate: () => {
      envA.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: () => Promise.resolve(2),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });
  expect(firstResult.ok).toBe(true);
  expect(
    getOfflineQueueEntries(sessionKey, 'runtime-mutation-queueing-a'),
  ).toHaveLength(1);

  // Tighten runtime queueing rules; only future mutations should be rejected.
  offlineSession.setOfflineRuntimeConfig({
    mutationQueueing: { network: 'disallow' },
  });

  const disallowedResult = await envA.apiStore.performMutation({
    optimisticUpdate: () => {
      envA.apiStore.updateState((draft) => {
        draft.value = 3;
      });
    },
    mutation: () => Promise.resolve(3),
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  expect(disallowedResult.ok).toBe(false);
  expect(disallowedResult.error).toMatchInlineSnapshot(
    `
      code: 0
      id: 'offline'
      message: 'Offline'
    `,
  );
  expect(
    getOfflineQueueEntries(sessionKey, 'runtime-mutation-queueing-a'),
  ).toHaveLength(1);

  const otherStoreResult = await envB.apiStore.performMutation({
    optimisticUpdate: () => {
      envB.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: () => Promise.resolve(2),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  expect(otherStoreResult.ok).toBe(false);
  expect(otherStoreResult.error).toMatchInlineSnapshot(
    `
      code: 0
      id: 'offline'
      message: 'Offline'
    `,
  );
  expect(
    getOfflineQueueEntries(sessionKey, 'runtime-mutation-queueing-b'),
  ).toHaveLength(0);

  // Resetting runtime config should allow subsequent mutations to queue again.
  offlineSession.resetOfflineRuntimeConfig();

  const resetResult = await envA.apiStore.performMutation({
    optimisticUpdate: () => {
      envA.apiStore.updateState((draft) => {
        draft.value = 4;
      });
    },
    mutation: () => Promise.resolve(4),
    offline: { operation: 'updateValue', input: { value: 4 } },
  });

  expect(resetResult.ok).toBe(true);
  expect(
    getOfflineQueueEntries(sessionKey, 'runtime-mutation-queueing-a'),
  ).toHaveLength(2);
  expect(offlineSession.getOfflineRuntimeConfig()).toMatchInlineSnapshot(`
    mutationQueueing: { network: 'allow', outage: 'allow' }
    network: { enabled: '✅' }
    outage: { enabled: '❌' }
  `);
});

// Verifies that global selectors aggregate offline entities from all stores in the
// session, while per-store selectors only report that store's own queued mutations.
test('global and per-store offline entity selectors aggregate queued work across stores in the same session', async () => {
  network.setOffline();
  const sessionKey = 'shared-offline-entities';
  const pendingReplay = new Promise<{ value: number }>(() => {});

  function createEnv(storeName: string) {
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: createOfflineConfigForSessionKey(() => sessionKey, {
          network: network.config,
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: ({ input }: UpdateValueExecuteContext) => {
                env.apiStore.updateState((draft) => {
                  draft.value = input.value;
                });
                return pendingReplay;
              },
            },
          },
        }),
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
    mutation: () => Promise.resolve(2),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  // Queue work in the second store; the global selector should now include both.
  await envB.apiStore.performMutation({
    optimisticUpdate: () => {
      envB.apiStore.updateState((draft) => {
        draft.value = 3;
      });
    },
    mutation: () => Promise.resolve(3),
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
