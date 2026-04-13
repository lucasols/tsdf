import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getGlobalOfflineStatus, useGlobalOfflineStatus } from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { docSchema } from './offlineTestShared';

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
      offlineSession: { classifyFailure },
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
  // over without changing the visible offline state.
  env.addTimelineComments('beforeNextAction', [
    'the browser reports offline and takes over network mode detection',
  ]);
  await act(async () => {
    network.goOffline();
    await Promise.resolve();
  });

  expect(statusHook.result.current).toMatchInlineSnapshot(`
    isLeader: '✅'
    isOfflineMode: '✅'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: 1735689600060
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'classified-network-browser-offline-session'
    updatedAt: 1735689600075
  `);

  // After the browser takeover, the classified probe loop must remain stopped.
  await advanceTime(200);

  expect(recoveryCheck).toHaveBeenCalledTimes(1);
  expect(getGlobalOfflineStatus(sessionKey)).toEqual(statusHook.result.current);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time | ui                                                               |
    0    | "offlineMode:off network:off lastCheck:none updated:0 probes:0"  | ui-initialized
    10ms | "offlineMode:off network:off lastCheck:none updated:10 probes:0" | ui-changed
    .    | "offlineMode:off network:off lastCheck:none updated:10 probes:0" | 🔴 >fetch-started
    .    | "offlineMode:off network:off lastCheck:none updated:10 probes:0" | 🔴 <fetch-error (value: "error")
    .    | "offlineMode:on network:on lastCheck:none updated:10 probes:0"   | ui-changed
    60ms | "offlineMode:on network:on lastCheck:none updated:10 probes:0"   | -- wait for the first classified-network probe before the browser reports offline
    .    | "offlineMode:on network:on lastCheck:60 updated:60 probes:1"     | ui-changed
    75ms | "offlineMode:on network:on lastCheck:60 updated:60 probes:1"     | -- the browser reports offline and takes over network mode detection
    .    | "offlineMode:on network:on lastCheck:60 updated:75 probes:1"     | ui-changed
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
    time | ui                                                               |
    0    | "offlineMode:off network:off lastCheck:none updated:0 probes:0"  | ui-initialized
    10ms | "offlineMode:off network:off lastCheck:none updated:10 probes:0" | ui-changed
    .    | "offlineMode:off network:off lastCheck:none updated:10 probes:0" | 🔴 >fetch-started
    .    | "offlineMode:off network:off lastCheck:none updated:10 probes:0" | 🔴 <fetch-error (value: "error")
    .    | "offlineMode:on network:on lastCheck:none updated:10 probes:0"   | ui-changed
    60ms | "offlineMode:on network:on lastCheck:none updated:10 probes:0"   | -- wait for the first classified-network probe before the browser starts driving connectivity
    .    | "offlineMode:on network:on lastCheck:60 updated:60 probes:1"     | ui-changed
    75ms | "offlineMode:on network:on lastCheck:60 updated:60 probes:1"     | -- the browser reports offline and takes over network mode detection
    .    | "offlineMode:on network:on lastCheck:60 updated:75 probes:1"     | ui-changed
    .    | "offlineMode:on network:on lastCheck:60 updated:75 probes:1"     | -- the browser reports online and clears the interrupted classified-network state
    .    | "offlineMode:off network:off lastCheck:60 updated:75 probes:1"   | ui-changed
    "
  `);
  statusHook.unmount();
});
