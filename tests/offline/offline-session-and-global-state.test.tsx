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
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import {
  getOfflineQueueEntries,
  type UpdateValueOperations,
} from './offlineReplayTestShared';
import {
  collectionSchema,
  docMutationInputSchema,
  docSchema,
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
