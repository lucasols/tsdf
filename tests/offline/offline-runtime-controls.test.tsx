import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { createOfflineSession, getGlobalOfflineStatus } from '../../src/main';
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

function getGlobalOfflineStatusSummary(sessionKey: string) {
  return pick(getGlobalOfflineStatus(sessionKey), [
    'isOfflineMode',
    'network',
    'outage',
    'sessionKey',
  ]);
}

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

  // Disabling both modes should keep the observed state but remove their
  // effective participation in offline behavior.
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
    isOfflineMode: '❌'
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
    ⋅ isOfflineMode: ❌
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
    isOfflineMode: '❌'
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
    error: { code: 500, id: 'fetch-error', message: 'disabled-network-direct-error' }
    ok: '❌'
  `);
  expect(directMutationWhileDisabled).toHaveBeenCalledTimes(1);

  // Reads should also bypass offline short-circuiting while runtime network
  // handling is disabled, even if the browser still reports offline.
  const requestHistoryBeforeDisabledFetch = structuredClone(
    env.serverMock.fetchHistory,
  );
  env.scheduleFetch('highPriority');
  await flushAllTimers();

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
    ⋅ isOfflineMode: ❌
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

test('disabled network support ignores classified network failures for new mutations', async () => {
  network.setOffline();
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
            execute: ({ input }: UpdateValueExecuteContext) => input,
          },
        },
      },
    },
  });

  await Promise.resolve();
  offlineSession.setOfflineRuntimeConfig({ network: { enabled: false } });
  await Promise.resolve();

  // Even though the raw browser-offline state is still remembered, disabled
  // network support must behave like network offline handling is absent.
  const result = await env.apiStore.performMutation({
    mutation: directMutation,
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  expect({ error: result.ok ? null : result.error, ok: result.ok })
    .toMatchInlineSnapshot(`
      error: { code: 500, id: 'fetch-error', message: 'disabled-network-error' }
      ok: '❌'
    `);
  expect(directMutation).toHaveBeenCalledTimes(1);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '✅', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'runtime-network-classification-disabled'
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

  // Queue a mutation through the normal browser-offline path so reconnecting
  // would replay it if runtime network handling were still enabled.
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
  expect(replayedInputs).toMatchInlineSnapshot(`[]`);

  // Disable runtime network support while the browser is still offline.
  offlineSession.setOfflineRuntimeConfig({ network: { enabled: false } });
  await Promise.resolve();
  statusRenders.addMark('Disable runtime network mode');
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
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
  await flushAllTimers();
  await waitForMicrotaskCondition(() => replayedInputs.length === 1);
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
    ⋅ isOfflineMode: ❌
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

test('disabling classified network mode pauses recovery until network support is re-enabled', async () => {
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

  // Disabling network support should stop recovery probing without clearing the
  // remembered classified network state.
  offlineSession.setOfflineRuntimeConfig({ network: { enabled: false } });
  await Promise.resolve();
  await advanceTime(250);

  expect(recoveryCheck).toHaveBeenCalledTimes(0);
  expect(replayedInputs).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '✅', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'runtime-classified-network-replay-pause'
  `);
  statusRenders.addMark('Disable runtime network mode');
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  // Re-enabling network support should resume the recovery probe loop from the
  // preserved classified network state.
  offlineSession.setOfflineRuntimeConfig({ network: { enabled: true } });
  await Promise.resolve();

  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'runtime-classified-network-replay-pause'
  `);
  statusRenders.addMark('Re-enable runtime network mode');
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
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-classified-network-replay-pause
    └─

    >>> Disable runtime network mode

    ┌─
    ⋅ isOfflineMode: ❌
    ⋅ network: {enabled:❌, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-classified-network-replay-pause
    └─

    >>> Re-enable runtime network mode

    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-classified-network-replay-pause
    └─

    >>> Recovery succeeds

    ┌─
    ⋅ isOfflineMode: ❌
    ⋅ network: {enabled:✅, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: runtime-classified-network-replay-pause
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
    isOfflineMode: '✅'
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
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '❌' }
    sessionKey: 'runtime-outage-replay-pause'
  `);
  statusRenders.addMark('Disable runtime outage mode');
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  // Re-enabling outage mode should restore the probe loop from the queued state.
  offlineSession.setOfflineRuntimeConfig({ outage: { enabled: true } });
  await Promise.resolve();

  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
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
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:✅, active:✅}
    ⋅ sessionKey: runtime-outage-replay-pause
    └─

    >>> Disable runtime outage mode

    ┌─
    ⋅ isOfflineMode: ❌
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:✅}
    ⋅ sessionKey: runtime-outage-replay-pause
    └─

    >>> Re-enable runtime outage mode

    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:✅, active:✅}
    ⋅ sessionKey: runtime-outage-replay-pause
    └─

    >>> Recovery succeeds

    ┌─
    ⋅ isOfflineMode: ❌
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:✅, active:❌}
    ⋅ sessionKey: runtime-outage-replay-pause
    └─
    "
  `);
});

test('direct-path success replays queued mutations even while runtime outage support stays disabled', async () => {
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
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '❌' }
    sessionKey: 'runtime-outage-remains-disabled-on-browser-reconnect'
  `);

  // Browser events alone should not clear outage mode while support is
  // disabled; only a real direct-path success should prove recovery.
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(replayedInputs).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '❌' }
    sessionKey: 'runtime-outage-remains-disabled-on-browser-reconnect'
  `);

  // A successful direct-path fetch should clear the remembered outage state and
  // immediately replay the mutation that was queued before outage support was disabled.
  const requestHistoryBeforeRecoveryFetch = structuredClone(
    env.serverMock.fetchHistory,
  );
  env.scheduleFetch('highPriority');
  await flushAllTimers();
  await waitForMicrotaskCondition(() => replayedInputs.length === 1);
  statusRenders.addMark('Direct fetch succeeds while disabled');
  statusRenders.add(getGlobalOfflineStatusSummary(sessionKey));

  expect(env.serverMock.fetchHistory).toHaveLength(
    requestHistoryBeforeRecoveryFetch.length + 1,
  );
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
    ⋅ isOfflineMode: ❌
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:✅}
    ⋅ sessionKey: runtime-outage-remains-disabled-on-browser-reconnect
    └─

    >>> Direct fetch succeeds while disabled

    ┌─
    ⋅ isOfflineMode: ❌
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
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
    return createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
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
            execute: ({ input }: UpdateValueExecuteContext) => input,
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
    isOfflineMode: '❌'
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

test('disabling runtime network support clears the bootstrap snapshot but preserves raw persisted status', async () => {
  network.setOffline();
  const sessionKey = 'runtime-disable-persistence-semantics';
  const offlineSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: { network: network.config },
  });

  createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
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
            execute: ({ input }: UpdateValueExecuteContext) => input,
          },
        },
      },
    },
  });

  await Promise.resolve();

  expect(parsePersistedObject(localStorage.getItem(`tsdf-os:${sessionKey}`)!))
    .toMatchInlineSnapshot(`
      d:
        n: { a: 1, e: 1 }
        u: 1735689600000
    `);

  offlineSession.setOfflineRuntimeConfig({ network: { enabled: false } });
  await Promise.resolve();

  expect(localStorage.getItem(`tsdf-os:${sessionKey}`)).toBeNull();
  expect(
    parsePersistedObject(localStorage.getItem(`tsdf.${sessionKey}._o_.s`)!),
  ).toMatchInlineSnapshot(`
    d:
      isLeader: '✅'
      isOfflineMode: '❌'
      lastFailureAt: null
      lastRecoveryCheckAt: null
      network: { active: '✅', enabled: '❌' }
      outage: { active: '❌', enabled: '❌' }
      sessionKey: 'runtime-disable-persistence-semantics'
      updatedAt: 1735689600000
  `);
});
