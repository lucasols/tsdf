import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { getGlobalOfflineStatus, useGlobalOfflineStatus } from '../../src/main';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { createOfflineConfigForSessionKey } from '../utils/offlineConfig';
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
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: createOfflineConfigForSessionKey(() => sessionKey, {
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
        operations: {},
      }),
    },
  });

  env.serverMock.setNextFetchError('boom');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(25);

  expect(classifyFailure).toHaveBeenCalledTimes(1);
  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    isLeader: '✅'
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
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: createOfflineConfigForSessionKey(() => sessionKey, {
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
        operations: {},
      }),
    },
  });
  const statusHook = renderHook(() => {
    const status = useGlobalOfflineStatus(sessionKey);
    env.trackUIChanges(
      `mode:${status.effectiveMode} network:${status.network.active ? 'on' : 'off'} probes:${probeCount}`,
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
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    isLeader: '✅'
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
    effectiveMode: 'online'
    effectiveOffline: '❌'
    isLeader: '✅'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: 1735689600310
    network: { active: '❌', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'classified-network-recovery-session'
    updatedAt: 1735689600310
  `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                                 |
    0     | "mode:online network:off probes:0" | ui-initialized
    10ms  | "mode:online network:off probes:0" | 🔴 >fetch-started
    .     | "mode:online network:off probes:0" | 🔴 <fetch-error (value: "error")
    .     | "mode:offline network:on probes:0" | ui-changed
    110ms | "mode:offline network:on probes:0" | -- wait for the first classified-network recovery probe; it should fail and keep network mode active
    .     | "mode:offline network:on probes:1" | ui-changed
    310ms | "mode:offline network:on probes:1" | -- wait for the second classified-network recovery probe; it should clear network mode
    .     | "mode:online network:off probes:2" | ui-changed
    "
  `);
  statusHook.unmount();
});

test('network classifications are ignored when network mode is disabled', async () => {
  const sessionKey = 'classified-network-disabled-session';
  const classifyFailure = vi.fn(() => 'network' as const);

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: createOfflineConfigForSessionKey(() => sessionKey, {
        classifyFailure,
        operations: {},
      }),
    },
  });

  env.serverMock.setNextFetchError('boom');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(25);

  expect(classifyFailure).toHaveBeenCalledTimes(1);
  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'online'
    effectiveOffline: '❌'
    isLeader: '✅'
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
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: createOfflineConfigForSessionKey(() => sessionKey, {
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
        operations: {},
      }),
    },
  });

  env.serverMock.setNextFetchError('boom');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(25);
  await advanceTime(50);

  expect(recoveryCheck).toHaveBeenCalledTimes(1);

  act(() => {
    network.goOffline();
  });
  await Promise.resolve();
  await Promise.resolve();

  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    isLeader: '✅'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: 1735689600060
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'classified-network-browser-offline-session'
    updatedAt: 1735689600075
  `);

  await advanceTime(200);

  expect(recoveryCheck).toHaveBeenCalledTimes(1);
});

test('coming back online after browser-driven network takeover clears the interrupted classified-network state', async () => {
  const sessionKey = 'classified-network-browser-online-session';
  const recoveryCheck = vi.fn(() => false);

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: createOfflineConfigForSessionKey(() => sessionKey, {
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
        operations: {},
      }),
    },
  });

  env.serverMock.setNextFetchError('boom');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(25);
  await advanceTime(50);

  expect(recoveryCheck).toHaveBeenCalledTimes(1);

  act(() => {
    network.goOffline();
  });
  await Promise.resolve();
  await Promise.resolve();

  act(() => {
    network.goOnline();
  });
  await Promise.resolve();
  await Promise.resolve();

  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'online'
    effectiveOffline: '❌'
    isLeader: '✅'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: 1735689600060
    network: { active: '❌', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'classified-network-browser-online-session'
    updatedAt: 1735689600075
  `);

  await advanceTime(200);

  expect(recoveryCheck).toHaveBeenCalledTimes(1);
});
