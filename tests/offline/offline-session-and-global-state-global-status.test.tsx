import { createLoggerStore } from '@ls-stack/utils/testUtils';
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
import type { OfflineSessionConfig } from '../../src/persistentStorage/offline/types';
import { createStoreManager } from '../../src/storeManager';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import {
  type UpdateValueExecuteContext,
  type UpdateValueOperations,
} from './offlineReplayTestShared';
import {
  collectionSchema,
  docMutationInputSchema,
  docSchema,
  parsePersistedObject,
  waitForMicrotaskCondition,
} from './offlineTestShared';
import { createManagedOfflineSession } from './offlineTestShared';

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

function getGlobalOfflineStatusSummary(sessionKey: string) {
  return pick(getGlobalOfflineStatus(sessionKey), [
    'isOfflineMode',
    'network',
    'outage',
    'sessionKey',
  ]);
}

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
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: { network: { enabled: true } },
    }),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations: {} },
    },
  });

  // A different store type joining the same session should not create a second
  // global status stream; both stores must converge on the same session state.
  createCollectionStoreTestEnv(
    { 'users||1': { name: 'User 1' } },
    {
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: { enabled: true } },
      }),
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: { operations: {} },
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
  const matchingConfig = {
    network: { enabled: true },
  } satisfies OfflineSessionConfig;
  const incompatibleConfig = {
    network: { enabled: true },
    outage: { enabled: true, recoveryCheck: () => false },
  } satisfies OfflineSessionConfig;
  createManagedOfflineSession({
    getSessionKey: () => sessionKey,
    config: matchingConfig,
  });
  const { offlineSession: incompatibleSession } = createManagedOfflineSession({
    getSessionKey: () => sessionKey,
    config: incompatibleConfig,
  });

  createDocumentStoreTestEnv(1, {
    id: 'incompatible-offline-session-a',
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: matchingConfig,
    }),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations: {} },
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
      kind: 'update'
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
      kind: 'update'
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
      kind: 'update'
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
      kind: 'update'
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
      kind: 'update'
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

// Global entity aggregates are populated by stores as they load, so a startup
// tray should stay empty until an offline-enabled store hydrates and
// contributes its session data.
test('global offline entities stay empty after restart until a store mounts', async () => {
  network.setOffline();

  const sessionKey = 'offline-global-entities-bootstrap';
  const storeName = 'offline-global-entities-bootstrap-doc';

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: storeName,
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

  // Persist queued work so a restarted app has something to show globally.
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
  await flushAllTimers();

  // Simulate a fresh app boot before any store mounts.
  resetSessionForTests();

  // Before any store has re-registered, the global aggregate should still be empty.
  expect(
    getGlobalOfflineEntities(sessionKey).map((entity) =>
      pick(entity, ['entityKey', 'pendingMutations', 'storeName', 'syncState']),
    ),
  ).toMatchInlineSnapshot(`[]`);

  // A startup-level hook sees the same empty aggregate until a store hydrates.
  const globalHook = renderHook(() => useGlobalOfflineEntities(sessionKey));

  expect(
    globalHook.result.current.map((entity) =>
      pick(entity, ['entityKey', 'pendingMutations', 'storeName', 'syncState']),
    ),
  ).toMatchInlineSnapshot(`[]`);

  // Once the store loads again, it republishes its offline state into the
  // shared session aggregate and the global hook updates.
  const restartedEnv = createDocumentStoreTestEnv<
    number,
    UpdateValueOperations
  >(1, {
    id: storeName,
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: { network: network.config },
    }),
    testScenario: 'idle',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            execute: async ({ input }: UpdateValueExecuteContext) => {
              await restartedEnv.serverMock.delayedSetData(input.value);
              return input;
            },
            onSuccessExecute: ({ input }) => {
              restartedEnv.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
            },
          },
        },
      },
    },
  });
  await flushAllTimers();

  expect(
    globalHook.result.current.map((entity) =>
      pick(entity, ['entityKey', 'pendingMutations', 'storeName', 'syncState']),
    ),
  ).toMatchInlineSnapshot(`
    - entityKey: 'document'
      pendingMutations: 1
      storeName: 'offline-global-entities-bootstrap-doc'
      syncState: 'pending'
  `);

  globalHook.unmount();
});
