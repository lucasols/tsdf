import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { createOfflineSession } from '../../src/main';
import { __resetSessionOfflineCoordinatorRegistryForTests } from '../../src/persistentStorage/offline/sessionCoordinator';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import {
  getOfflineQueueEntries,
  type UpdateValueExecuteContext,
  type UpdateValueOperations,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  collectionSchema,
  docMutationInputSchema,
  docSchema,
  getGlobalOfflineStatusSummary,
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

  // Disabling both modes should preserve the observed state while preventing
  // future operations from entering those offline causes.
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
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'shared-runtime-offline-controls'
  `);
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  // Re-enabling the runtime controls should reuse the preserved observed state.
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
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '✅' }
    sessionKey: 'shared-runtime-offline-controls'
  `);
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));
  expect(statusRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: shared-runtime-offline-controls
    └─

    >>> Disable runtime offline modes

    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:❌, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: shared-runtime-offline-controls
    └─

    >>> Re-enable runtime offline modes

    ┌─
    ⋅ isOfflineMode: ✅
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
    isOfflineMode: '✅'
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

test('disabling active network mode preserves offline state while future operations use the direct path', async () => {
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
    mutation: async () => {
      await env.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);

  // Disabling runtime network mode should preserve the existing offline state,
  // while future operations bypass new network offline admission.
  offlineSession.setOfflineRuntimeConfig({ network: { enabled: false } });
  await Promise.resolve();

  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'runtime-network-replay-pause'
  `);
  statusRenders.addMark('Disable runtime network mode');
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  // While network mode is disabled, new offline-enabled mutations should use
  // the direct path instead of entering the durable queue. In a realistic
  // browser-offline scenario that direct request still fails normally.
  const directMutationWhileDisabled = vi.fn(() =>
    Promise.reject(new Error('disabled-network-direct-error')),
  );
  const disabledNetworkMutationResult = await env.apiStore.performMutation({
    mutation: directMutationWhileDisabled,
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  expect({
    error: disabledNetworkMutationResult.ok
      ? null
      : disabledNetworkMutationResult.error,
    ok: disabledNetworkMutationResult.ok,
  }).toMatchInlineSnapshot(`
    error{Error}:
      message: 'disabled-network-direct-error'
      name: 'StoreMutationError'
      kind: 'error'
      code: 500
      id: 'fetch-error'
      cause:
        Error#: { message: 'disabled-network-direct-error', name: 'Error' }

    ok: '❌'
  `);
  expect(directMutationWhileDisabled).toHaveBeenCalledTimes(1);

  // Reads should also bypass offline short-circuiting while runtime network
  // handling is disabled, even if the browser still reports offline.
  await flushAllTimers();
  const requestHistoryBeforeDisabledFetch = structuredClone(
    env.serverMock.fetchHistory,
  );
  env.errorInNextFetch('disabled-network-fetch-error');
  env.scheduleFetch('highPriority');
  await flushAllTimers();

  expect(pick(env.store.state, ['data', 'error', 'status']))
    .toMatchInlineSnapshot(`
      data: { value: 2 }
      error: { code: 500, id: 'fetch-error', message: 'disabled-network-fetch-error' }
      status: 'error'
    `);
  expect(
    env.serverMock.fetchHistory
      .slice(requestHistoryBeforeDisabledFetch.length)
      .map(({ error, result }) => ({ error: error?.message ?? null, result })),
  ).toMatchInlineSnapshot(`
    - { error: 'disabled-network-fetch-error', result: 'error' }
  `);

  expect(env.serverMock.fetchHistory).toHaveLength(
    requestHistoryBeforeDisabledFetch.length + 1,
  );

  await advanceTime(250);
  expect(replayedInputs).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);

  // Re-enabling network mode should restore offline status until connectivity returns.
  offlineSession.setOfflineRuntimeConfig({ network: { enabled: true } });
  await Promise.resolve();

  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
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
  await flushAllTimers();
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
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-network-replay-pause
    └─

    >>> Disable runtime network mode

    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:❌, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-network-replay-pause
    └─

    >>> Re-enable runtime network mode

    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-network-replay-pause
    └─

    >>> Browser reconnects

    ┌─
    ⋅ isOfflineMode: ❌
    ⋅ network: {enabled:✅, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-network-replay-pause
    └─
    "
  `);
});

test('disabled network support ignores classified network failures while starting from an online state', async () => {
  const sessionKey = 'runtime-network-classification-disabled';
  const storeName = 'runtime-network-classification-disabled-doc';
  const directMutation = vi.fn(() =>
    Promise.reject(new Error('disabled-network-error')),
  );
  const offlineSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: {
      classifyFailure: () => 'network' as const,
      network: {
        ...network.config,
        recoveryCheck: () => false,
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
  offlineSession.setOfflineRuntimeConfig({ network: { enabled: false } });
  await Promise.resolve();

  // Starting from a healthy online state, disabled network support should
  // behave as if network offline admission is absent.
  const result = await env.apiStore.performMutation({
    mutation: directMutation,
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  expect({ error: result.ok ? null : result.error, ok: result.ok })
    .toMatchInlineSnapshot(`
      error{Error}:
        message: 'disabled-network-error'
        name: 'StoreMutationError'
        kind: 'error'
        code: 500
        id: 'fetch-error'
        cause:
          Error#: { message: 'disabled-network-error', name: 'Error' }

      ok: '❌'
    `);
  expect(directMutation).toHaveBeenCalledTimes(1);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'runtime-network-classification-disabled'
  `);
});

test('disabled outage support ignores outage classifications while starting from an online state', async () => {
  const sessionKey = 'runtime-outage-classification-disabled';
  const storeName = 'runtime-outage-classification-disabled-doc';
  const directMutation = vi.fn(() =>
    Promise.reject(new Error('disabled-outage-error')),
  );
  const offlineSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: {
      classifyFailure: () => 'outage' as const,
      outage: { enabled: true, recoveryCheck: () => false },
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
  offlineSession.setOfflineRuntimeConfig({ outage: { enabled: false } });
  await Promise.resolve();

  const result = await env.apiStore.performMutation({
    mutation: directMutation,
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  expect({ error: result.ok ? null : result.error, ok: result.ok })
    .toMatchInlineSnapshot(`
      error{Error}:
        message: 'disabled-outage-error'
        name: 'StoreMutationError'
        kind: 'error'
        code: 500
        id: 'fetch-error'
        cause:
          Error#: { message: 'disabled-outage-error', name: 'Error' }

      ok: '❌'
    `);
  expect(directMutation).toHaveBeenCalledTimes(1);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'runtime-outage-classification-disabled'
  `);
});

test('browser reconnects replay queued mutations even while runtime network support stays disabled', async () => {
  network.setOffline();
  const sessionKey = 'runtime-network-remains-disabled-on-browser-reconnect';
  const storeName = 'runtime-network-remains-disabled-on-browser-reconnect-doc';
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

  await Promise.resolve();
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  // Queue a mutation through the normal browser-offline path so reconnecting
  // would replay it if runtime network handling were still enabled.
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

  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);
  expect(replayedInputs).toMatchInlineSnapshot(`[]`);

  // Disable runtime network support while the browser is still offline.
  offlineSession.setOfflineRuntimeConfig({ network: { enabled: false } });
  await Promise.resolve();
  statusRenders.addMark('Disable runtime network mode');
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'runtime-network-remains-disabled-on-browser-reconnect'
  `);

  // Reads should use the same direct path while runtime network handling is
  // disabled, rather than short-circuiting as offline.
  const requestHistoryBeforeDisabledFetch = structuredClone(
    env.serverMock.fetchHistory,
  );
  env.scheduleFetch('highPriority');
  await flushAllTimers();

  expect(pick(env.store.state, ['data', 'error', 'status']))
    .toMatchInlineSnapshot(`
      data: { value: 1 }
      error: null
      status: 'success'
    `);
  expect(env.serverMock.fetchHistory).toHaveLength(
    requestHistoryBeforeDisabledFetch.length + 1,
  );
  expect(replayedInputs).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);

  // Once the browser really reconnects, the remembered network snapshot should
  // clear and the already-queued mutation should replay without re-enabling the
  // runtime network mode.
  act(() => {
    network.goOnline();
  });
  await Promise.resolve();
  await waitForMicrotaskCondition(() => replayedInputs.length === 1);
  await flushAllTimers();
  statusRenders.addMark('Browser reconnects while disabled');
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  expect(replayedInputs).toMatchInlineSnapshot(`
    - value: 2
  `);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'runtime-network-remains-disabled-on-browser-reconnect'
  `);
  expect(statusRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-network-remains-disabled-on-browser-reconnect
    └─

    >>> Disable runtime network mode

    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:❌, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-network-remains-disabled-on-browser-reconnect
    └─

    >>> Browser reconnects while disabled

    ┌─
    ⋅ isOfflineMode: ❌
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-network-remains-disabled-on-browser-reconnect
    └─
    "
  `);
});

test('disabling classified network mode preserves recovery and replay for already-active work', async () => {
  const sessionKey = 'runtime-classified-network-replay-pause';
  const storeName = 'runtime-classified-network-replay-pause-doc';
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
      classifyFailure: () => 'network' as const,
      network: {
        ...network.config,
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

  // The initial classified network failure queues the mutation and starts
  // network recovery probing while the browser still reports online.
  const fallbackResult = await env.apiStore.performMutation({
    mutation: () => Promise.reject(new Error('network fallback')),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));
  expect(fallbackResult.ok).toBe(true);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'runtime-classified-network-replay-pause'
  `);

  // Disabling network support should not discard already-active classified
  // recovery work. The recovery loop keeps running until it succeeds.
  offlineSession.setOfflineRuntimeConfig({ network: { enabled: false } });
  await Promise.resolve();
  statusRenders.addMark('Disable runtime network mode');
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));
  await advanceTime(250);
  await flushAllTimers();

  expect(recoveryCheck).toHaveBeenCalledTimes(2);
  expect(replayedInputs).toMatchInlineSnapshot(`
    - value: 2
  `);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'runtime-classified-network-replay-pause'
  `);
  statusRenders.addMark('Recovery succeeds while disabled');
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));
  expect(statusRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-classified-network-replay-pause
    └─

    >>> Disable runtime network mode

    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:❌, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-classified-network-replay-pause
    └─

    >>> Recovery succeeds while disabled

    ┌─
    ⋅ isOfflineMode: ❌
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-classified-network-replay-pause
    └─
    "
  `);
});

test('disabling active outage mode preserves recovery and replay for already-active work', async () => {
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
    isOfflineMode: '✅'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'runtime-outage-replay-pause'
  `);

  // Disabling runtime outage mode should not discard already-active outage
  // recovery work. The recovery loop keeps running until it succeeds.
  offlineSession.setOfflineRuntimeConfig({ outage: { enabled: false } });
  await Promise.resolve();
  statusRenders.addMark('Disable runtime outage mode');
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));
  await advanceTime(250);
  await flushAllTimers();

  expect(recoveryCheck).toHaveBeenCalledTimes(2);
  expect(replayedInputs).toMatchInlineSnapshot(`
    - value: 2
  `);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'runtime-outage-replay-pause'
  `);
  statusRenders.addMark('Recovery succeeds while disabled');
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));
  expect(statusRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:✅, active:✅}
    ⋅ sessionKey: runtime-outage-replay-pause
    └─

    >>> Disable runtime outage mode

    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:✅}
    ⋅ sessionKey: runtime-outage-replay-pause
    └─

    >>> Recovery succeeds while disabled

    ┌─
    ⋅ isOfflineMode: ❌
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-outage-replay-pause
    └─
    "
  `);
});

test('browser events do not clear preserved outage state while runtime outage support stays disabled', async () => {
  const sessionKey = 'runtime-outage-remains-disabled-on-browser-reconnect';
  const storeName = 'runtime-outage-remains-disabled-on-browser-reconnect-doc';
  const replayedInputs: { value: number }[] = [];
  const statusRenders = createLoggerStore();
  const offlineSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: {
      classifyFailure: () => 'outage' as const,
      outage: { enabled: true, recoveryCheck: () => false },
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

  // Queue a mutation through the normal outage-classification path so the
  // browser's online event would be a tempting but incorrect replay trigger.
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
  expect(replayedInputs).toMatchInlineSnapshot(`[]`);

  // Disable runtime outage support before any recovery can happen.
  offlineSession.setOfflineRuntimeConfig({ outage: { enabled: false } });
  await Promise.resolve();
  statusRenders.addMark('Disable runtime outage mode');
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '❌' }
    sessionKey: 'runtime-outage-remains-disabled-on-browser-reconnect'
  `);

  // Browser events alone should not clear outage mode while support is disabled.
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();
  act(() => {
    network.goOnline();
  });
  await Promise.resolve();
  statusRenders.addMark('Browser events while disabled');
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  expect(replayedInputs).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '❌' }
    sessionKey: 'runtime-outage-remains-disabled-on-browser-reconnect'
  `);

  expect(statusRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:✅, active:✅}
    ⋅ sessionKey: runtime-outage-remains-disabled-on-browser-reconnect
    └─

    >>> Disable runtime outage mode

    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:✅}
    ⋅ sessionKey: runtime-outage-remains-disabled-on-browser-reconnect
    └─

    >>> Browser events while disabled

    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:✅}
    ⋅ sessionKey: runtime-outage-remains-disabled-on-browser-reconnect
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
    mutation: async () => {
      await envA.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });
  expect(firstResult.ok).toBe(true);
  expect(
    getOfflineQueueEntries(sessionKey, 'runtime-mutation-queueing-a'),
  ).toHaveLength(1);

  // Tighten runtime queueing rules; future mutations should stop queueing but
  // still follow the normal direct mutation path.
  offlineSession.setOfflineRuntimeConfig({
    mutationQueueing: { network: 'disallow' },
  });

  const directMutationA = vi.fn(() =>
    navigator.onLine
      ? envA.serverMock.delayedSetData(3).then(() => 3)
      : Promise.reject(new Error('runtime-network-disallowed-direct-error-a')),
  );
  const disallowedResult = await envA.apiStore.performMutation({
    optimisticUpdate: () => {
      envA.apiStore.updateState((draft) => {
        draft.value = 3;
      });
    },
    mutation: directMutationA,
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  expect(disallowedResult.ok).toBe(false);
  expect(disallowedResult.error).toMatchInlineSnapshot(
    `
      Error#:
        message: 'runtime-network-disallowed-direct-error-a'
        name: 'StoreMutationError'
        kind: 'error'
        code: 500
        id: 'fetch-error'
        cause:
          Error#: { message: 'runtime-network-disallowed-direct-error-a', name: 'Error' }
    `,
  );
  expect(directMutationA).toHaveBeenCalledTimes(1);
  expect(
    getOfflineQueueEntries(sessionKey, 'runtime-mutation-queueing-a'),
  ).toHaveLength(1);

  const directMutationB = vi.fn(() =>
    navigator.onLine
      ? envB.serverMock.delayedSetData(2).then(() => 2)
      : Promise.reject(new Error('runtime-network-disallowed-direct-error-b')),
  );
  const otherStoreResult = await envB.apiStore.performMutation({
    optimisticUpdate: () => {
      envB.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: directMutationB,
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  expect(otherStoreResult.ok).toBe(false);
  expect(otherStoreResult.error).toMatchInlineSnapshot(
    `
      Error#:
        message: 'runtime-network-disallowed-direct-error-b'
        name: 'StoreMutationError'
        kind: 'error'
        code: 500
        id: 'fetch-error'
        cause:
          Error#: { message: 'runtime-network-disallowed-direct-error-b', name: 'Error' }
    `,
  );
  expect(directMutationB).toHaveBeenCalledTimes(1);
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
    mutation: async () => {
      await envA.serverMock.delayedSetData(4);
      return 4;
    },
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

test('disabling runtime network mutation queueing does not change offline fetch behavior', async () => {
  const sessionKey = 'runtime-mutation-queueing-fetch-network';
  const offlineSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: { network: network.config },
  });
  const env = createDocumentStoreTestEnv(1, {
    id: 'runtime-mutation-queueing-fetch-network-doc',
    getSessionKey: () => sessionKey,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { session: offlineSession, operations: {} },
    },
  });

  await flushAllTimers();

  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  offlineSession.setOfflineRuntimeConfig({
    mutationQueueing: { network: 'disallow' },
  });
  await Promise.resolve();

  expect(offlineSession.getOfflineRuntimeConfig()).toMatchInlineSnapshot(`
    mutationQueueing: { network: 'disallow', outage: 'allow' }
    network: { enabled: '✅' }
    outage: { enabled: '❌' }
  `);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'runtime-mutation-queueing-fetch-network'
  `);

  const requestHistoryBeforeOfflineFetch = structuredClone(
    env.serverMock.fetchHistory,
  );

  // Disabling mutation queueing should not make reads bypass the active offline
  // mode. Cached reads should still short-circuit without touching the server.
  env.scheduleFetch('highPriority');
  await flushAllTimers();

  const awaitedResultPromise = env.apiStore.awaitFetch();
  await flushAllTimers();
  const awaitedResult = await awaitedResultPromise;

  expect({
    awaitedResult,
    state: pick(env.store.state, ['data', 'error', 'status']),
  }).toMatchInlineSnapshot(`
    awaitedResult:
      data: { value: 1 }
      error: null

    state:
      data: { value: 1 }
      error: null
      status: 'success'
  `);
  expect(env.serverMock.fetchHistory).toEqual(requestHistoryBeforeOfflineFetch);
});

test('disabling runtime outage mutation queueing does not change outage fetch behavior', async () => {
  const sessionKey = 'runtime-mutation-queueing-fetch-outage';
  const offlineSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: {
      classifyFailure: () => 'outage' as const,
      outage: {
        enabled: true,
        recoveryCheck: () => false,
        recoveryProbe: {
          initialIntervalMs: 100,
          maxIntervalMs: 100,
          backoffMultiplier: 1,
          jitterRatio: 0,
        },
      },
    },
  });
  const env = createDocumentStoreTestEnv(1, {
    id: 'runtime-mutation-queueing-fetch-outage-doc',
    getSessionKey: () => sessionKey,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { session: offlineSession, operations: {} },
    },
  });

  await flushAllTimers();

  // First enter outage mode through the normal classified fetch path.
  env.serverMock.setNextFetchError('boom');
  env.scheduleFetch('highPriority');
  await advanceTime(25);

  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'runtime-mutation-queueing-fetch-outage'
  `);

  offlineSession.setOfflineRuntimeConfig({
    mutationQueueing: { outage: 'disallow' },
  });
  await Promise.resolve();

  expect(offlineSession.getOfflineRuntimeConfig()).toMatchInlineSnapshot(`
    mutationQueueing: { network: 'allow', outage: 'disallow' }
    network: { enabled: '❌' }
    outage: { enabled: '✅' }
  `);

  const requestHistoryBeforeOfflineFetch = structuredClone(
    env.serverMock.fetchHistory,
  );

  // Outage-mode reads should keep using the cached offline path even after
  // queueing new outage-classified mutations is disabled.
  env.scheduleFetch('highPriority');
  await advanceTime(25);

  const awaitedResultPromise = env.apiStore.awaitFetch();
  await advanceTime(25);
  const awaitedResult = await awaitedResultPromise;

  expect({
    awaitedResult,
    state: pick(env.store.state, ['data', 'error', 'status']),
  }).toMatchInlineSnapshot(`
    awaitedResult:
      data: { value: 1 }
      error: null

    state:
      data: { value: 1 }
      error: null
      status: 'success'
  `);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'runtime-mutation-queueing-fetch-outage'
  `);
  expect(env.serverMock.fetchHistory).toEqual(requestHistoryBeforeOfflineFetch);
});

test('configured runtime-disabled modes can be enabled later without rebuilding the session', async () => {
  network.setOffline();
  const sessionKey = 'runtime-disabled-by-default-modes';
  const recoveryCheck = vi.fn(() => false);
  const offlineSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: {
      classifyFailure: () => 'outage' as const,
      network: { ...network.config, enabled: false },
      outage: { enabled: false, recoveryCheck },
    },
  });

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: 'runtime-disabled-by-default-doc',
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

  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'runtime-disabled-by-default-modes'
  `);

  // Enabling network support later should immediately start using the preserved
  // network config without rebuilding the store.
  offlineSession.setOfflineRuntimeConfig({ network: { enabled: true } });
  await Promise.resolve();

  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'runtime-disabled-by-default-modes'
  `);

  // Disable network again, enable outage support, and verify outage handling
  // also works without rebuilding the session.
  offlineSession.setOfflineRuntimeConfig({
    network: { enabled: false },
    outage: { enabled: true },
  });
  await Promise.resolve();

  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '❌' }
    outage: { active: '❌', enabled: '✅' }
    sessionKey: 'runtime-disabled-by-default-modes'
  `);

  const outageResult = await env.apiStore.performMutation({
    mutation: () => Promise.reject(new Error('outage-after-enable')),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  expect(outageResult.ok).toBe(true);
  expect(
    getOfflineQueueEntries(sessionKey, 'runtime-disabled-by-default-doc'),
  ).toHaveLength(1);
  expect(recoveryCheck).toHaveBeenCalledTimes(0);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '❌' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'runtime-disabled-by-default-modes'
  `);
});

test('disabling runtime network support preserves the compact persisted status for existing offline work', async () => {
  network.setOffline();
  const sessionKey = 'runtime-disable-persistence-semantics';
  const offlineSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: { network: network.config },
  });

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: 'runtime-disable-persistence-doc',
    getSessionKey: () => sessionKey,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        session: offlineSession,
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

  expect(
    parsePersistedObject(localStorage.getItem(`tsdf.${sessionKey}._o_.s`)!),
  ).toMatchInlineSnapshot(`
    d:
      n: { a: 1, e: 1 }
      u: 1735689600000
  `);

  offlineSession.setOfflineRuntimeConfig({ network: { enabled: false } });
  await Promise.resolve();

  expect(
    parsePersistedObject(localStorage.getItem(`tsdf.${sessionKey}._o_.s`)!),
  ).toMatchInlineSnapshot(`
    d:
      n: { a: 1 }
      u: 1735689600000
  `);
});
