import { sleep } from '@ls-stack/utils/sleep';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getGlobalOfflineStatus, useGlobalOfflineStatus } from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createFocusChangeCoordinator } from '../browser-tabs/browser-tabs-test-helpers';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import {
  HEALTH_CHECK_DURATION_MS,
  createHealthCheckMock,
  createOfflineUsersEnv,
  healthRecoveryProbe,
  trackOfflineSession,
  userItemIds,
} from './offlineHealthCheckTestShared';
import { userRowSchema } from './offlineReplayTestShared';
import {
  docSchema,
  getGlobalOfflineStatusSummary,
  listQueryQueryPayloadSchema,
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

test('classified network failures activate network mode and shift fetches into offline handling', async () => {
  const sessionKey = 'classified-network-session';
  const classifyFailure = vi.fn(() => 'network' as const);

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
        classifyFailure,
        network: {
          ...network.config,
          recoveryCheck: () => true,
          recoveryProbe: {
            initialIntervalMs: 100,
            maxIntervalMs: 100,
            backoffMultiplier: 1,
            jitterRatio: 0,
          },
        },
      },
    }),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations: {} },
    },
  });

  env.serverMock.setNextFetchError('boom');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(25);

  expect(classifyFailure).toHaveBeenCalledTimes(1);
  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    isLeader: '✅'
    isOfflineMode: '✅'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: null
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'classified-network-session'
    updatedAt: 1735689600010
  `);
  expect(env.store.state.error).toMatchInlineSnapshot(`
    code: 0
    id: 'offline'
    message: 'Offline'
  `);
});

test('classified network recovery uses network-specific probes and clears network mode after recovery', async () => {
  const sessionKey = 'classified-network-recovery-session';
  let probeCount = 0;
  const recoveryCheck = vi.fn<
    ({ sessionKey }: { sessionKey: string }) => boolean
  >(({ sessionKey: resolvedSessionKey }) => {
    expect(resolvedSessionKey).toBe(sessionKey);
    probeCount += 1;
    return probeCount >= 2;
  });

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
        classifyFailure: () => 'network' as const,
        network: {
          ...network.config,
          recoveryCheck,
          recoveryProbe: {
            initialIntervalMs: 100,
            maxIntervalMs: 200,
            backoffMultiplier: 2,
            jitterRatio: 0,
          },
        },
      },
    }),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations: {} },
    },
  });
  const statusHook = renderHook(() => {
    const status = useGlobalOfflineStatus(sessionKey);
    env.trackUIChanges(
      `offlineMode:${status.isOfflineMode ? 'on' : 'off'} network:${status.network.active ? 'on' : 'off'} probes:${probeCount}`,
    );
    return status;
  });

  env.serverMock.setNextFetchError('boom');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(25);

  expect(recoveryCheck).toHaveBeenCalledTimes(0);

  env.addTimelineComments('beforeNextAction', [
    'wait for the first classified-network recovery probe; it should fail and keep network mode active',
  ]);
  await advanceTime(100);

  expect(recoveryCheck).toHaveBeenCalledTimes(1);
  expect(statusHook.result.current).toMatchInlineSnapshot(`
    isLeader: '✅'
    isOfflineMode: '✅'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: 1735689600110
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'classified-network-recovery-session'
    updatedAt: 1735689600110
  `);

  env.addTimelineComments('beforeNextAction', [
    'wait for the second classified-network recovery probe; it should clear network mode',
  ]);
  await advanceTime(200);

  expect(recoveryCheck).toHaveBeenCalledTimes(2);
  expect(statusHook.result.current).toMatchInlineSnapshot(`
    isLeader: '✅'
    isOfflineMode: '❌'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: 1735689600310
    network: { active: '❌', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'classified-network-recovery-session'
    updatedAt: 1735689600310
  `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                                     |
    0     | "offlineMode:off network:off probes:0" | ui-initialized
    10ms  | "offlineMode:off network:off probes:0" | 🔴 >fetch-started
    .     | "offlineMode:off network:off probes:0" | 🔴 <fetch-error (value: "error")
    .     | "offlineMode:on network:on probes:0"   | ui-changed
    110ms | "offlineMode:on network:on probes:0"   | -- wait for the first classified-network recovery probe; it should fail and keep network mode active
    .     | "offlineMode:on network:on probes:1"   | ui-changed
    310ms | "offlineMode:on network:on probes:1"   | -- wait for the second classified-network recovery probe; it should clear network mode
    .     | "offlineMode:off network:off probes:2" | ui-changed
    "
  `);
  statusHook.unmount();
});

test('network classifications are ignored when network mode is disabled', async () => {
  const sessionKey = 'classified-network-disabled-session';
  const classifyFailure = vi.fn(() => 'network' as const);

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
        classifyFailure,
        // Failures are only classified while some mode is enabled, so outage
        // mode keeps the classifier consulted while network mode stays off.
        outage: { enabled: true, recoveryCheck: () => true },
      },
    }),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations: {} },
    },
  });

  env.serverMock.setNextFetchError('boom');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(25);

  // The failure was classified as `network`, which is not enabled: the
  // session stays online.
  expect(classifyFailure).toHaveBeenCalledTimes(1);
  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    isLeader: '✅'
    isOfflineMode: '❌'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'classified-network-disabled-session'
    updatedAt: 1735689600000
  `);
  expect(env.store.state.error?.id ?? null).not.toBe('offline');
});

test('browser offline events stop classified-network probing and hand control to detected network mode', async () => {
  const sessionKey = 'classified-network-browser-offline-session';
  const recoveryCheck = vi.fn(() => false);

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
        classifyFailure: () => 'network' as const,
        network: {
          ...network.config,
          recoveryCheck,
          recoveryProbe: {
            initialIntervalMs: 50,
            maxIntervalMs: 50,
            backoffMultiplier: 1,
            jitterRatio: 0,
          },
        },
      },
    }),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations: {} },
    },
  });
  const statusHook = renderHook(() => {
    const status = useGlobalOfflineStatus(sessionKey);
    env.trackUIChanges(
      `offlineMode:${status.isOfflineMode ? 'on' : 'off'} network:${status.network.active ? 'on' : 'off'} lastCheck:${status.lastRecoveryCheckAt === null ? 'none' : status.lastRecoveryCheckAt - TEST_INITIAL_TIME} updated:${status.updatedAt - TEST_INITIAL_TIME} probes:${recoveryCheck.mock.calls.length}`,
    );
    return status;
  });

  // Start in classified network mode so there is an active probe loop to
  // interrupt with the browser-level offline signal.
  env.serverMock.setNextFetchError('boom');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(25);

  expect(statusHook.result.current).toMatchInlineSnapshot(`
    isLeader: '✅'
    isOfflineMode: '✅'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: null
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'classified-network-browser-offline-session'
    updatedAt: 1735689600010
  `);

  // Let the first classified recovery probe run so the test can prove the
  // browser event stops any further probe scheduling.
  env.addTimelineComments('beforeNextAction', [
    'wait for the first classified-network probe before the browser reports offline',
  ]);
  await advanceTime(50);

  expect(recoveryCheck).toHaveBeenCalledTimes(1);

  // Once the browser reports itself offline, detected network mode should take
  // over without changing the offline status at all.
  await act(async () => {
    network.goOffline();
    await Promise.resolve();
  });
  env.addTimelineComments('afterLastAction', [
    'the browser reports offline and takes over network mode detection: no status change',
  ]);

  expect(statusHook.result.current).toMatchInlineSnapshot(`
    isLeader: '✅'
    isOfflineMode: '✅'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: 1735689600060
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'classified-network-browser-offline-session'
    updatedAt: 1735689600060
  `);

  // After the browser takeover, the classified probe loop must remain stopped.
  await advanceTime(200);

  expect(recoveryCheck).toHaveBeenCalledTimes(1);
  expect(getGlobalOfflineStatus(sessionKey)).toEqual(statusHook.result.current);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time | ui                                                              |
    0    | "offlineMode:off network:off lastCheck:none updated:0 probes:0" | ui-initialized
    10ms | "offlineMode:off network:off lastCheck:none updated:0 probes:0" | 🔴 >fetch-started
    .    | "offlineMode:off network:off lastCheck:none updated:0 probes:0" | 🔴 <fetch-error (value: "error")
    .    | "offlineMode:on network:on lastCheck:none updated:10 probes:0"  | ui-changed
    60ms | "offlineMode:on network:on lastCheck:none updated:10 probes:0"  | -- wait for the first classified-network probe before the browser reports offline
    .    | "offlineMode:on network:on lastCheck:60 updated:60 probes:1"    | ui-changed
    .    | "offlineMode:on network:on lastCheck:60 updated:60 probes:1"    | -- the browser reports offline and takes over network mode detection: no status change
    "
  `);
  statusHook.unmount();
});

test('coming back online after browser-driven network takeover clears the interrupted classified-network state', async () => {
  const sessionKey = 'classified-network-browser-online-session';
  const recoveryCheck = vi.fn(() => false);

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
        classifyFailure: () => 'network' as const,
        network: {
          ...network.config,
          recoveryCheck,
          recoveryProbe: {
            initialIntervalMs: 50,
            maxIntervalMs: 50,
            backoffMultiplier: 1,
            jitterRatio: 0,
          },
        },
      },
    }),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations: {} },
    },
  });
  const statusHook = renderHook(() => {
    const status = useGlobalOfflineStatus(sessionKey);
    env.trackUIChanges(
      `offlineMode:${status.isOfflineMode ? 'on' : 'off'} network:${status.network.active ? 'on' : 'off'} lastCheck:${status.lastRecoveryCheckAt === null ? 'none' : status.lastRecoveryCheckAt - TEST_INITIAL_TIME} updated:${status.updatedAt - TEST_INITIAL_TIME} probes:${recoveryCheck.mock.calls.length}`,
    );
    return status;
  });

  // Start in classified network mode so the browser offline/online pair can
  // interrupt the probe loop and then clear it entirely.
  env.serverMock.setNextFetchError('boom');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(25);

  expect(statusHook.result.current).toMatchInlineSnapshot(`
    isLeader: '✅'
    isOfflineMode: '✅'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: null
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'classified-network-browser-online-session'
    updatedAt: 1735689600010
  `);

  // Allow one probe to run before the browser takes control so the test proves
  // the old classified recovery loop does not resume afterward.
  env.addTimelineComments('beforeNextAction', [
    'wait for the first classified-network probe before the browser starts driving connectivity',
  ]);
  await advanceTime(50);

  expect(recoveryCheck).toHaveBeenCalledTimes(1);

  // The browser going offline should preserve offline mode while switching to
  // detected connectivity control.
  env.addTimelineComments('beforeNextAction', [
    'the browser reports offline and takes over network mode detection',
  ]);
  await act(async () => {
    network.goOffline();
    await Promise.resolve();
  });

  // Coming back online should clear the interrupted classified-network state
  // instead of restarting probes in the background.
  env.addTimelineComments('beforeNextAction', [
    'the browser reports online and clears the interrupted classified-network state',
  ]);
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });

  expect(statusHook.result.current).toMatchInlineSnapshot(`
    isLeader: '✅'
    isOfflineMode: '❌'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: 1735689600060
    network: { active: '❌', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'classified-network-browser-online-session'
    updatedAt: 1735689600075
  `);

  // The browser-driven recovery should finish the transition without any more
  // classified-network recovery checks firing later.
  await advanceTime(200);

  expect(recoveryCheck).toHaveBeenCalledTimes(1);
  expect(getGlobalOfflineStatus(sessionKey)).toEqual(statusHook.result.current);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time | ui                                                              |
    0    | "offlineMode:off network:off lastCheck:none updated:0 probes:0" | ui-initialized
    10ms | "offlineMode:off network:off lastCheck:none updated:0 probes:0" | 🔴 >fetch-started
    .    | "offlineMode:off network:off lastCheck:none updated:0 probes:0" | 🔴 <fetch-error (value: "error")
    .    | "offlineMode:on network:on lastCheck:none updated:10 probes:0"  | ui-changed
    60ms | "offlineMode:on network:on lastCheck:none updated:10 probes:0"  | -- wait for the first classified-network probe before the browser starts driving connectivity
    .    | "offlineMode:on network:on lastCheck:60 updated:60 probes:1"    | ui-changed
    75ms | "offlineMode:on network:on lastCheck:60 updated:60 probes:1"    | -- the browser reports offline and takes over network mode detection
    .    | "offlineMode:on network:on lastCheck:60 updated:60 probes:1"    | -- the browser reports online and clears the interrupted classified-network state
    .    | "offlineMode:off network:off lastCheck:60 updated:75 probes:1"  | ui-changed
    "
  `);
  statusHook.unmount();
});

function createRealtimeUsersEnv(sessionKey: string) {
  return createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      usesRealTimeUpdates: true,
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: { operations: {} },
      },
    },
  );
}

function renderUsersList(
  env: ReturnType<typeof createRealtimeUsersEnv>,
  renders: ReturnType<typeof createLoggerStore>,
) {
  return renderHook(() => {
    const query = env.apiStore.useListQuery(
      { tableId: 'users' },
      { returnRefetchingStatus: true },
    );

    renders.add({
      status: query.status,
      names: query.items.map((item) => item.name),
    });
  });
}

test('a realtime transport reconnect while offline keeps the cached list untouched and revalidates it once when back online', async () => {
  const env = createRealtimeUsersEnv('offline-reconnect-hold-session');
  const renders = createLoggerStore();

  const hook = renderUsersList(env, renders);
  await flushAllTimers();

  env.serverTable.updateItem('users||1', { name: 'Ada (edited elsewhere)' });

  // The websocket reconnects while the session is offline (e.g. a captive
  // network): revalidating now could only fail, so nothing is invalidated.
  renders.addMark('offline, then the realtime transport reconnects');
  act(() => {
    network.goOffline();
  });
  act(() => {
    env.apiStore.onTransportReconnect();
  });
  await flushAllTimers();

  // Leaving offline mode revalidates by itself, without the app having to
  // signal a reconnect again.
  renders.addMark('back online');
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: loading ⋅ names: []
    -> status: success ⋅ names: [Ada]

    >>> offline, then the realtime transport reconnects

    -> status: success ⋅ names: [Ada]

    >>> back online

    -> status: success ⋅ names: [Ada]
    -> status: refetching ⋅ names: [Ada]
    -> status: success ⋅ names: [Ada (edited elsewhere)]
    "
  `);
  // One load plus the single revalidation after recovering.
  expect(
    env.serverTable.getRequestHistory('list', { includeTime: false }).length,
  ).toBe(2);

  hook.unmount();
});

test('coming back online and then reconnecting the realtime transport revalidates the list once', async () => {
  const env = createRealtimeUsersEnv('offline-recovery-then-reconnect-session');
  const renders = createLoggerStore();

  const hook = renderUsersList(env, renders);
  await flushAllTimers();
  env.serverTable.clearFetchHistory();

  act(() => {
    network.goOffline();
  });
  await advanceTime(5_000);

  env.serverTable.updateItem('users||1', { name: 'Ada (edited elsewhere)' });

  // The usual order in a realtime app: the browser is back online first and
  // the app's websocket reconnects a moment later.
  renders.addMark('back online');
  act(() => {
    network.goOnline();
  });
  await advanceTime(500);
  // Recovering waits for the transport reconnect that usually follows it:
  // nothing was refetched yet.
  expect(env.serverTable.getRequestHistory('list')).toHaveLength(0);

  renders.addMark('the realtime transport reconnects');
  act(() => {
    env.apiStore.onTransportReconnect();
  });
  await flushAllTimers();

  // Both are covered by a single revalidation, run right at the reconnect.
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: loading ⋅ names: []
    -> status: success ⋅ names: [Ada]

    >>> back online

    -> status: success ⋅ names: [Ada]

    >>> the realtime transport reconnects

    -> status: refetching ⋅ names: [Ada]
    -> status: success ⋅ names: [Ada (edited elsewhere)]
    "
  `);
  expect(env.serverTable.getRequestHistory('list')).toHaveLength(1);

  hook.unmount();
});

test('coming back online without a realtime transport reconnect revalidates the list once the reconnect cooldown ends', async () => {
  const env = createRealtimeUsersEnv(
    'offline-recovery-without-reconnect-session',
  );
  const renders = createLoggerStore();

  const hook = renderUsersList(env, renders);
  await flushAllTimers();
  env.serverTable.clearFetchHistory();

  act(() => {
    network.goOffline();
  });
  await advanceTime(5_000);

  env.serverTable.updateItem('users||1', { name: 'Ada (edited elsewhere)' });

  // The transport was already back (or never dropped), so no reconnect
  // follows the recovery.
  renders.addMark('back online');
  act(() => {
    network.goOnline();
  });
  // The recovery waits for a transport reconnect during the 2s reconnect
  // cooldown...
  await advanceTime(1_900);
  expect(env.serverTable.getRequestHistory('list')).toHaveLength(0);

  // ...and still revalidates once the cooldown ends without one.
  renders.addMark('the reconnect cooldown ends');
  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: loading ⋅ names: []
    -> status: success ⋅ names: [Ada]

    >>> back online

    -> status: success ⋅ names: [Ada]

    >>> the reconnect cooldown ends

    -> status: refetching ⋅ names: [Ada]
    -> status: success ⋅ names: [Ada (edited elsewhere)]
    "
  `);
  expect(env.serverTable.getRequestHistory('list')).toHaveLength(1);

  hook.unmount();
});

test('a reconnect revalidation deferred by the cooldown does not run after the session goes offline', async () => {
  const env = createRealtimeUsersEnv('offline-reconnect-cooldown-session');
  const renders = createLoggerStore();

  const hook = renderUsersList(env, renders);
  await flushAllTimers();

  // First reconnect revalidates right away; a second one inside the cooldown
  // window is deferred to the end of the window.
  renders.addMark('two reconnects in a row');
  act(() => {
    env.apiStore.onTransportReconnect();
  });
  await flushAllTimers();
  act(() => {
    env.apiStore.onTransportReconnect();
  });

  // The session goes offline before the deferred revalidation fires.
  renders.addMark('offline before the deferred revalidation fires');
  act(() => {
    network.goOffline();
  });
  await flushAllTimers();

  // The deferred revalidation is dropped: the list is not sent into a
  // refetch that can only fail.
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: loading ⋅ names: []
    -> status: success ⋅ names: [Ada]

    >>> two reconnects in a row

    -> status: refetching ⋅ names: [Ada]
    -> status: success ⋅ names: [Ada]

    >>> offline before the deferred revalidation fires

    -> status: success ⋅ names: [Ada]
    "
  `);

  hook.unmount();
});

test('a document that failed to load offline loads by itself when the session comes back online', async () => {
  const sessionKey = 'offline-recovery-document-session';
  network.setOffline();

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: { network: network.config },
    }),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations: {} },
    },
  });
  const renders = createLoggerStore();

  // Nothing is cached, so the offline mount can only show the offline error.
  const hook = renderHook(() => {
    const doc = env.apiStore.useDocument();
    renders.add({ status: doc.status, data: doc.data, error: doc.error?.id });
  });
  await flushAllTimers();

  renders.addMark('back online');
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  // No remount or manual invalidation is needed to recover.
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: loading ⋅ data: null ⋅ error: undefined
    -> status: error ⋅ data: null ⋅ error: offline

    >>> back online

    -> status: loading ⋅ data: null ⋅ error: undefined
    -> status: success ⋅ data: {value:1} ⋅ error: undefined
    "
  `);

  hook.unmount();
});

// A real recovery check is a request, so it takes a while. A fetch attempted
// meanwhile re-reads the connectivity and re-arms the recovery probe; when the
// in-flight check then settled it armed a second timer without cancelling
// that one, leaving two probe loops running (and one more per repetition).
test('fetches attempted while a recovery check is in flight do not multiply the recovery checks', async () => {
  const sessionKey = 'classified-network-single-probe-loop-session';
  const RECOVERY_CHECK_DURATION_MS = 100;
  const recoveryCheckStartedAt: number[] = [];
  // The backend stays unreachable during the whole test.
  const recoveryCheck = vi.fn(async () => {
    recoveryCheckStartedAt.push(Date.now() - TEST_INITIAL_TIME);
    await sleep(RECOVERY_CHECK_DURATION_MS);
    return false;
  });
  const env = createOfflineUsersEnv(sessionKey, {
    classifyFailure: () => 'network' as const,
    network: {
      ...network.config,
      recoveryCheck,
      // One recovery check per second.
      recoveryProbe: healthRecoveryProbe,
    },
  });

  // -- Enter classified network mode through a failed fetch (at 10ms) --
  env.serverTable.setNextFetchError('users||1', 'failed to fetch');
  env.scheduleItemFetch('highPriority', 'users||1');
  await advanceTime(50);

  // -- The 1st recovery check starts at 1010ms and is in flight --
  await advanceTime(1_000);
  expect(recoveryCheck).toHaveBeenCalledTimes(1);

  // -- The user opens two other items while that check is in flight --
  env.scheduleItemFetch('highPriority', 'users||2');
  await advanceTime(20);
  env.scheduleItemFetch('highPriority', 'users||3');
  await advanceTime(RECOVERY_CHECK_DURATION_MS);

  // -- Five more seconds in network mode --
  await advanceTime(5 * (1_000 + RECOVERY_CHECK_DURATION_MS));

  // Still a single loop: each check starts one interval after the previous
  // one settled.
  expect(recoveryCheckStartedAt).toMatchInlineSnapshot(
    `[1010, 2110, 3210, 4310, 5410, 6510]`,
  );
});

// ---------------------------------------------------------------------------
// `offlineSession.healthCheck` answering "unreachable": the browser still
// reports online (captive wifi, VPN down, DNS failure...) but the backend
// cannot be reached from this device.
// ---------------------------------------------------------------------------

test('a burst of requests failing while the backend is unreachable costs one health check, enters network mode and recovers through the same check', async () => {
  const sessionKey = 'health-check-unreachable-session';
  const health = createHealthCheckMock();
  const env = createOfflineUsersEnv(sessionKey, {
    healthCheck: { check: health.check },
    // No `network.recoveryCheck`: the health check is the recovery check.
    network: { ...network.config, recoveryProbe: healthRecoveryProbe },
  });
  const session = trackOfflineSession(sessionKey, health);

  // -- The backend becomes unreachable while three items are loading --
  health.setBackend('unreachable');
  for (const itemId of userItemIds) {
    env.serverTable.setNextFetchError(itemId, 'failed to fetch');
    env.scheduleItemFetch('highPriority', itemId);
  }
  await advanceTime(50 + HEALTH_CHECK_DURATION_MS);

  // Three failures shared one health request, which put the session in
  // network mode even though the browser still reports online.
  expect(health.check).toHaveBeenCalledTimes(1);
  expect(network.isOnline()).toBe(true);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'health-check-unreachable-session'
  `);
  expect(
    userItemIds.map((itemId) => env.getItemQueryState(itemId)?.error?.message),
  ).toMatchInlineSnapshot(`['Offline', 'Offline', 'Offline']`);

  // -- A new fetch while in network mode --
  const requestsBeforeOfflineFetch = env.serverTable.getRequestHistory('all', {
    includeTime: false,
  }).length;
  env.scheduleItemFetch('highPriority', 'users||1');
  await advanceTime(50);

  // The browser reporting online does not end the mode by itself: the fetch
  // is answered as offline without a request and without a health check.
  expect(
    env.serverTable.getRequestHistory('all', { includeTime: false }).length,
  ).toBe(requestsBeforeOfflineFetch);
  expect(health.check).toHaveBeenCalledTimes(1);
  expect(getGlobalOfflineStatusSummary(sessionKey).isOfflineMode).toBe(true);

  // -- 1st recovery check: still unreachable --
  session.log.addMark('1st recovery check: still unreachable');
  await advanceTime(
    healthRecoveryProbe.initialIntervalMs + HEALTH_CHECK_DURATION_MS,
  );

  expect(health.check).toHaveBeenCalledTimes(2);
  expect(getGlobalOfflineStatusSummary(sessionKey).isOfflineMode).toBe(true);

  // -- 2nd recovery check: the backend is reachable again --
  session.log.addMark('2nd recovery check: reachable again');
  health.setBackend('up');
  await advanceTime(
    healthRecoveryProbe.initialIntervalMs + HEALTH_CHECK_DURATION_MS,
  );

  expect(health.check).toHaveBeenCalledTimes(3);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'health-check-unreachable-session'
  `);

  // Back online the checks stop.
  await advanceTime(10 * healthRecoveryProbe.initialIntervalMs);
  expect(health.check).toHaveBeenCalledTimes(3);
  expect(session.log.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> at: 0ms ⋅ session: online ⋅ healthChecks: 0
    -> at: 110ms ⋅ session: offline (network) ⋅ healthChecks: 1

    >>> 1st recovery check: still unreachable

    -> at: 1210ms ⋅ session: offline (network) ⋅ healthChecks: 2

    >>> 2nd recovery check: reachable again

    -> at: 2310ms ⋅ session: online ⋅ healthChecks: 3
    "
  `);

  session.unmount();
});

test('a reused "up" answer is dropped when the browser goes offline, so the first failure after reconnecting asks the health check again', async () => {
  const sessionKey = 'health-check-reuse-up-network-session';
  const health = createHealthCheckMock();
  const env = createOfflineUsersEnv(sessionKey, {
    healthCheck: { check: health.check, reuseUpForFailuresMs: 30_000 },
    network: { ...network.config, recoveryProbe: healthRecoveryProbe },
  });
  const session = trackOfflineSession(sessionKey, health);

  async function failUser1Fetch(error: string) {
    env.serverTable.setNextFetchError('users||1', error);
    env.scheduleItemFetch('highPriority', 'users||1');
    await advanceTime(50 + HEALTH_CHECK_DURATION_MS);
  }

  // -- An endpoint fails twice while the backend is up --
  session.log.addMark('two failures while the backend is up');
  await failUser1Fetch('internal error');
  await failUser1Fetch('internal error');

  // The second failure reused the "up" of the first one.
  expect(health.check).toHaveBeenCalledTimes(1);

  // -- The browser loses the connection for a few seconds --
  session.log.addMark('the browser is offline for 2s');
  act(() => {
    network.goOffline();
  });
  await advanceTime(2_000);
  act(() => {
    network.goOnline();
  });

  // -- Reconnected, but the backend is not reachable from here yet --
  session.log.addMark('a failure after reconnecting');
  health.setBackend('unreachable');
  await failUser1Fetch('failed to fetch');

  // Still inside the 30s of the old "up", but going offline dropped it: the
  // failure asked the health check, which found the backend unreachable.
  expect(health.check).toHaveBeenCalledTimes(2);
  expect(env.getItemQueryState('users||1')?.error?.message).toBe('Offline');
  expect(session.log.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> at: 0ms ⋅ session: online ⋅ healthChecks: 0

    >>> two failures while the backend is up

    >>> the browser is offline for 2s

    -> at: 300ms ⋅ session: offline (network) ⋅ healthChecks: 1
    -> at: 2300ms ⋅ session: online ⋅ healthChecks: 1

    >>> a failure after reconnecting

    -> at: 2410ms ⋅ session: offline (network) ⋅ healthChecks: 2
    "
  `);

  session.unmount();
});

test('recovery answers of the health check move the session between network and outage mode until it answers "up"', async () => {
  const sessionKey = 'health-check-mode-switch-session';
  const health = createHealthCheckMock();
  const env = createOfflineUsersEnv(sessionKey, {
    healthCheck: { check: health.check },
    network: { ...network.config, recoveryProbe: healthRecoveryProbe },
    outage: { enabled: true, recoveryProbe: healthRecoveryProbe },
  });
  const session = trackOfflineSession(sessionKey, health);

  async function waitForNextRecoveryCheck() {
    await advanceTime(
      healthRecoveryProbe.initialIntervalMs + HEALTH_CHECK_DURATION_MS,
    );
  }

  // -- A fetch fails while the backend is unreachable --
  health.setBackend('unreachable');
  env.serverTable.setNextFetchError('users||1', 'failed to fetch');
  env.scheduleItemFetch('highPriority', 'users||1');
  await advanceTime(50 + HEALTH_CHECK_DURATION_MS);

  // -- The device reaches the backend again, but the backend is down --
  session.log.addMark('recovery check answers "outage"');
  health.setBackend('outage');
  await waitForNextRecoveryCheck();

  // The network problem is over and an outage took its place.
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '❌', enabled: '✅' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'health-check-mode-switch-session'
  `);

  // -- The backend cannot be reached anymore --
  session.log.addMark('recovery check answers "unreachable"');
  health.setBackend('unreachable');
  await waitForNextRecoveryCheck();

  // Network mode is back. Nothing can be said about the outage while the
  // backend is unreachable, so it is kept.
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'health-check-mode-switch-session'
  `);

  // -- Everything is healthy again --
  session.log.addMark('recovery check answers "up"');
  health.setBackend('up');
  await waitForNextRecoveryCheck();

  // One "up" answer ends both causes: no second check is needed for the
  // outage.
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '✅' }
    outage: { active: '❌', enabled: '✅' }
    sessionKey: 'health-check-mode-switch-session'
  `);
  expect(session.log.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> at: 0ms ⋅ session: online ⋅ healthChecks: 0
    -> at: 110ms ⋅ session: offline (network) ⋅ healthChecks: 1

    >>> recovery check answers "outage"

    -> at: 1210ms ⋅ session: offline (outage) ⋅ healthChecks: 2

    >>> recovery check answers "unreachable"

    -> at: 2310ms ⋅ session: offline (network + outage) ⋅ healthChecks: 3

    >>> recovery check answers "up"

    -> at: 3410ms ⋅ session: online ⋅ healthChecks: 4
    "
  `);

  session.unmount();
});

test('a store of a manager without offline support revalidates when another manager of the same session recovers', async () => {
  const sessionKey = 'offline-recovery-shared-session';

  // Two managers share the session: only one of them has offline support,
  // but the session's offline mode applies to the stores of both.
  const offlineManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: { network: network.config },
  });
  createDocumentStoreTestEnv(1, {
    id: 'offline-enabled-doc',
    getSessionKey: () => sessionKey,
    storeManager: offlineManager,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations: {} },
    },
  });

  const env = createDocumentStoreTestEnv(1, {
    id: 'realtime-doc',
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
    }),
    usesRealTimeUpdates: true,
  });
  const renders = createLoggerStore();

  const hook = renderHook(() => {
    const doc = env.apiStore.useDocument();
    renders.add({ status: doc.status, data: doc.data });
  });
  await flushAllTimers();

  env.serverMock.setData(2);

  // The realtime transport reconnects while the session is offline: the
  // revalidation is held, since it could only fail.
  renders.addMark('offline, then the realtime transport reconnects');
  act(() => {
    network.goOffline();
  });
  act(() => {
    env.apiStore.onTransportReconnect();
  });
  await flushAllTimers();

  // The held revalidation runs once the session recovers.
  renders.addMark('back online');
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: loading ⋅ data: null
    -> status: success ⋅ data: {value:1}

    >>> offline, then the realtime transport reconnects

    >>> back online

    -> status: success ⋅ data: {value:2}
    "
  `);

  hook.unmount();
});

test('a realtime transport reconnect re-checks connectivity and leaves offline mode when the app tracks it itself', async () => {
  const sessionKey = 'offline-reconnect-recheck-session';

  // The app ties offline detection to its own realtime socket and does not
  // listen to browser events: nothing else tells the session when the
  // connection is back.
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: {
      network: { ...network.config, listenToBrowserEvents: false },
    },
  });
  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    storeManager,
    usesRealTimeUpdates: true,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations: {} },
    },
  });
  const renders = createLoggerStore();

  const hook = renderHook(() => {
    const doc = env.apiStore.useDocument();
    renders.add({ status: doc.status, data: doc.data });
  });
  await flushAllTimers();

  // The socket drops: the next fetch finds out the session is offline.
  renders.addMark('socket drops');
  network.setOffline();
  act(() => {
    env.apiStore.invalidateData('highPriority');
  });
  await flushAllTimers();
  expect(getGlobalOfflineStatus(sessionKey).isOfflineMode).toBe(true);

  env.serverMock.setData(2);

  // The socket reconnects and the app signals it: the reconnect re-checks
  // connectivity, leaves offline mode and the document revalidates.
  renders.addMark('socket reconnects');
  network.setOnline();
  act(() => {
    storeManager.onTransportReconnect();
  });
  await flushAllTimers();

  expect(getGlobalOfflineStatus(sessionKey).isOfflineMode).toBe(false);
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: loading ⋅ data: null
    -> status: success ⋅ data: {value:1}

    >>> socket drops

    >>> socket reconnects

    -> status: success ⋅ data: {value:2}
    "
  `);
  // The load plus a single revalidation: the offline fetch never reached
  // the server, and the reconnect did not refetch on top of the recovery.
  expect(env.serverMock.numOfStartedFetches).toBe(2);

  hook.unmount();
});

test('a window focus re-checks connectivity and leaves offline mode entered by a classified network failure', async () => {
  const sessionKey = 'offline-focus-recheck-session';
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  // Fetch failures classified as network errors put the session in offline
  // mode while the browser still reports being online, and no recovery
  // check is configured to probe the connection.
  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
        classifyFailure: () => 'network',
        network: network.config,
      },
    }),
    revalidateOnWindowFocus: true,
    bindFocusController: tabs.bind('a'),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations: {} },
    },
  });
  const renders = createLoggerStore();

  const hook = renderHook(() => {
    const doc = env.apiStore.useDocument();
    renders.add({ status: doc.status, data: doc.data });
  });
  await flushAllTimers();

  renders.addMark('a fetch fails with a network error');
  env.serverMock.setNextFetchError('connection lost');
  act(() => {
    env.apiStore.invalidateData('highPriority');
  });
  await flushAllTimers();
  expect(getGlobalOfflineStatus(sessionKey).isOfflineMode).toBe(true);

  env.serverMock.setData(2);

  // Coming back to the tab re-checks connectivity: the browser reports being
  // online, so the session leaves offline mode and the document revalidates.
  renders.addMark('user comes back to the tab');
  await tabs.blur();
  await tabs.focusTab('a');
  await flushAllTimers();

  expect(getGlobalOfflineStatus(sessionKey).isOfflineMode).toBe(false);
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: loading ⋅ data: null
    -> status: success ⋅ data: {value:1}

    >>> a fetch fails with a network error

    >>> user comes back to the tab

    -> status: success ⋅ data: {value:2}
    "
  `);
  // The load, the failed fetch and a single revalidation: the focus did not
  // refetch on top of the recovery.
  expect(env.serverMock.numOfStartedFetches).toBe(3);

  hook.unmount();
});

test('a window focus while offline probes the connection once for all the stores of the session', async () => {
  const sessionKey = 'offline-focus-single-probe-session';
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  // The app probes the connection itself (e.g. pinging its server), which
  // takes a while and costs a request per call.
  const probeConnection = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return network.isOffline();
  });
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: {
      network: {
        ...network.config,
        listenToBrowserEvents: false,
        getIsOffline: probeConnection,
      },
    },
  });
  const createStoreEnv = (id: string) =>
    createDocumentStoreTestEnv(1, {
      id,
      getSessionKey: () => sessionKey,
      storeManager,
      revalidateOnWindowFocus: true,
      bindFocusController: tabs.bind('a'),
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: { operations: {} },
      },
    });
  const profileEnv = createStoreEnv('offline-focus-probe-profile');
  const settingsEnv = createStoreEnv('offline-focus-probe-settings');

  const hook = renderHook(() => {
    profileEnv.apiStore.useDocument();
    settingsEnv.apiStore.useDocument();
  });
  await flushAllTimers();

  // The connection drops: the next fetch finds out the session is offline.
  network.setOffline();
  act(() => {
    profileEnv.apiStore.invalidateData('highPriority');
  });
  await flushAllTimers();
  expect(getGlobalOfflineStatus(sessionKey).isOfflineMode).toBe(true);

  // Coming back to the tab while still offline: both stores would revalidate
  // on focus, but a single probe is enough to know the session is offline.
  probeConnection.mockClear();
  await tabs.blur();
  await tabs.focusTab('a');
  await flushAllTimers();

  expect(probeConnection).toHaveBeenCalledTimes(1);
  expect(getGlobalOfflineStatus(sessionKey).isOfflineMode).toBe(true);

  hook.unmount();
});
