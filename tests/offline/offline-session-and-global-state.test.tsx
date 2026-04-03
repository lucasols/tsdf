import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
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

test('persistent storage without offlineMode keeps the existing online flow even when the browser reports offline', async () => {
  network.setOffline();

  const sessionKey = 'offline-opt-in-required';
  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => sessionKey,
    testScenario: 'idle',
    persistentStorage: { adapter: 'local-sync', schema: docSchema },
  });

  // Without offlineMode config, the store should operate normally even when the browser is offline.
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
      offlineMode: {
        network: network.config,
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            execute: ({ input }: UpdateValueExecuteContext) => input,
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
      mutation: () => Promise.resolve(2),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });
  });

  expect(getGlobalOfflineEntities('offline-session-cleanup')).toMatchObject([
    { entityKey: 'document', storeName: 'offline-session-cleanup-doc' },
  ]);

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
      offlineMode: {
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
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                    |
    0     | "value:1 pending:no"  | ui-initialized
    .     | "value:2 pending:no"  | ui-changed
    .     | "value:2 pending:yes" | ui-changed
    .     | "value:2 pending:no"  | ui-changed
    10ms  | "value:2 pending:no"  | -- the browser goes back online while the app is logged out
    .     | "value:2 pending:no"  | 🔴 >fetch-started
    810ms | "value:2 pending:no"  | 🔴 <fetch-finished (value: 1)
    .     | "value:1 pending:no"  | ui-changed
    1.81s | "value:1 pending:no"  | -- the same session logs back in and triggers a normal online fetch
    .     | "value:1 pending:no"  | scheduled-fetch-triggered
    1.82s | "value:1 pending:yes" | ui-changed
    .     | "value:1 pending:yes" | 🟠 >fetch-started
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

test('global and store offline entities expose temp-create dependency metadata once replay reaches manual resolution', async () => {
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
        offlineMode: {
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
        },
      },
    },
  );

  // Queue a temp create and a dependent edit while fully offline.
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

  // Let the temp create exhaust replay so the parent and child dependency
  // metadata becomes visible through both store-scoped and global entity APIs.
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

  const [storeEntity] = env.apiStore.getOfflineEntities();
  const [globalEntity] = getGlobalOfflineEntities(sessionKey);
  const parentResolution = env.apiStore
    .getOfflineResolutions()
    .find((resolution) => resolution.operation === 'createUser');
  const childResolution = env.apiStore
    .getOfflineResolutions()
    .find((resolution) => resolution.operation === 'patchUserName');

  expect(storeEntity).toMatchObject({
    blockedByResolutionIds: [parentResolution?.id],
    blockedResolutionCount: 1,
    childResolutionCount: 1,
    childResolutionIds: [childResolution?.id],
    entityKey: env.getStoreItemKeyFromRaw('temp:Linus offline'),
    requiresResolution: true,
    syncState: 'resolution-required',
  });
  expect(globalEntity).toMatchObject({
    blockedByResolutionIds: [parentResolution?.id],
    blockedResolutionCount: 1,
    childResolutionCount: 1,
    childResolutionIds: [childResolution?.id],
    entityKey: env.getStoreItemKeyFromRaw('temp:Linus offline'),
    requiresResolution: true,
    storeName: 'offline-session-temp-create-dependencies-store',
  });
});

// Each store manages its own offline lifecycle -- a store without offlineMode
// should never surface pending-sync or offline-entity state from sibling stores.
test('plain stores do not inherit offline state from other stores in the same session', async () => {
  network.setOffline();
  const sessionKey = 'offline-entity-scope-session';

  const offlineEnv = createDocumentStoreTestEnv<number, UpdateValueOperations>(
    1,
    {
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offlineMode: {
          network: network.config,
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: ({ input }: UpdateValueExecuteContext) => {
                offlineEnv.apiStore.updateState((draft) => {
                  draft.value = input.value;
                });
                return input;
              },
            },
          },
        },
      },
    },
  );
  const plainEnv = createDocumentStoreTestEnv<number, UpdateValueOperations>(
    10,
    { getSessionKey: () => sessionKey, testScenario: 'loaded' },
  );

  await Promise.resolve();
  await offlineEnv.apiStore.performMutation({
    optimisticUpdate: () => {
      offlineEnv.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: () => Promise.resolve(2),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  const documentHook = renderHook(() => plainEnv.apiStore.useDocument());
  expect(documentHook.result.current.pendingSync).toBe(false);
  expect(
    Object.prototype.hasOwnProperty.call(
      documentHook.result.current,
      'pendingOfflineMutations',
    ),
  ).toBe(false);
  expect(
    Object.prototype.hasOwnProperty.call(
      documentHook.result.current,
      'hasOfflineResolution',
    ),
  ).toBe(false);
  documentHook.unmount();

  const offlineEntitiesHook = renderHook(() =>
    plainEnv.apiStore.useOfflineEntities(),
  );
  expect(offlineEntitiesHook.result.current).toMatchInlineSnapshot(`[]`);
  offlineEntitiesHook.unmount();
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
      offlineMode: {
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
    mutation: () => Promise.resolve(2),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  expect(mutationResult.ok).toBe(false);
  expect(mutationResult.error).toMatchObject({
    id: 'offline-session-unavailable',
  });
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

  const globalHook = renderHook(() => useGlobalOfflineStatus(sessionKey));
  expect(globalHook.result.current).toMatchObject({
    effectiveOffline: false,
    sessionKey,
  });

  let mutationOk = false;
  await act(async () => {
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: 'offline-global-hook-doc',
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offlineMode: {
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
        },
      },
    });

    await Promise.resolve();
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
  expect(globalHook.result.current).toMatchObject({
    effectiveOffline: true,
    effectiveMode: 'offline',
    sessionKey,
  });
  expect(localStorage.getItem(`tsdf-os:${sessionKey}`)).not.toBeNull();

  // Once the session is back online, the startup bootstrap snapshot should be
  // cleared so future boots do not resurrect a stale offline state.
  await act(async () => {
    network.goOnline();
    await waitForMicrotaskCondition(
      () => localStorage.getItem(`tsdf-os:${sessionKey}`) === null,
    );
  });

  await advanceTime(1010);
  expect(
    readManagedLocalStorageSingleEntryByPayload(
      `tsdf.${sessionKey}.offline-global-hook-doc`,
    ),
  ).toMatchObject({ meta: { o: true } });

  act(() => {
    globalHook.unmount();
  });
});

// After a restart, the app should recover the previous offline state from
// localStorage immediately instead of waiting for store hydration to confirm it.
test('app restart boots global offline status from the persisted localStorage snapshot', () => {
  const sessionKey = 'offline-startup-bootstrap';
  localStorage.setItem(
    `tsdf-os:${sessionKey}`,
    JSON.stringify({
      d: { s: sessionKey, n: { e: 1, a: 1 }, u: TEST_INITIAL_TIME },
    }),
  );

  expect(
    pick(getGlobalOfflineStatus(sessionKey), [
      'effectiveMode',
      'effectiveOffline',
      'network',
      'outage',
      'sessionKey',
    ]),
  ).toMatchInlineSnapshot(`
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'offline-startup-bootstrap'
  `);

  const hook = renderHook(() =>
    pick(useGlobalOfflineStatus(sessionKey), [
      'effectiveMode',
      'effectiveOffline',
      'network',
      'outage',
      'sessionKey',
    ]),
  );

  expect(hook.result.current).toMatchInlineSnapshot(`
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'offline-startup-bootstrap'
  `);

  hook.unmount();
});

// Multiple stores sharing the same session key should report a single, consistent
// global offline status so the app can rely on one source of truth.
test('global offline status is shared across stores in the same session', async () => {
  network.setOffline();
  const sessionKey = 'shared-offline-session';

  createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offlineMode: { network: { enabled: true }, operations: {} },
    },
  });

  createCollectionStoreTestEnv(
    { 'users||1': { name: 'User 1' } },
    {
      getSessionKey: () => sessionKey,
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offlineMode: { network: { enabled: true }, operations: {} },
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

  const hook = renderHook(() => useGlobalOfflineStatus(sessionKey));
  expect(hook.result.current.effectiveOffline).toBe(true);
  hook.unmount();
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
        offlineMode: {
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
        },
      },
    });
    return env;
  }

  const envA = createEnv('offline-doc-a');
  const envB = createEnv('offline-doc-b');
  await Promise.resolve();
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  await envA.apiStore.performMutation({
    optimisticUpdate: () => {
      envA.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: () => Promise.resolve(2),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  await envB.apiStore.performMutation({
    optimisticUpdate: () => {
      envB.apiStore.updateState((draft) => {
        draft.value = 3;
      });
    },
    mutation: () => Promise.resolve(3),
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  expect(getGlobalOfflineEntities(sessionKey)).toMatchObject([
    { entityKey: 'document', pendingMutations: 1, storeName: 'offline-doc-a' },
    { entityKey: 'document', pendingMutations: 1, storeName: 'offline-doc-b' },
  ]);

  const globalHook = renderHook(() => useGlobalOfflineEntities(sessionKey));
  expect(globalHook.result.current).toHaveLength(2);
  globalHook.unmount();

  const storeHook = renderHook(() => envA.apiStore.useOfflineEntities());
  expect(storeHook.result.current).toMatchObject([
    { entityKey: 'document', pendingMutations: 1, storeName: 'offline-doc-a' },
  ]);
  storeHook.unmount();
});
