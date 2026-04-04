import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { getGlobalOfflineStatus, useGlobalOfflineStatus } from '../../src/main';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { createOfflineConfigForSessionKey } from '../utils/offlineConfig';
import { docSchema } from './offlineTestShared';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  createOfflineNetworkMock().install();
  localStorage.clear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  localStorage.clear();
});

test('async outage classification promotes the session into outage mode after a failed fetch', async () => {
  const sessionKey = 'outage-session';
  const classifyFailure = vi.fn(
    async (
      _error: unknown,
      ctx: {
        phase: 'fetch' | 'mutation' | 'sync';
        storeType: 'document' | 'collection' | 'listQuery';
        operationName?: string;
        sessionKey: string;
      },
    ) => {
      expect(ctx).toMatchInlineSnapshot(`
        phase: 'fetch'
        sessionKey: 'outage-session'
        storeType: 'document'
      `);

      await Promise.resolve();
      return 'outage' as const;
    },
  );
  const recoveryCheck = vi.fn(() => true);

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: createOfflineConfigForSessionKey(() => sessionKey, {
        classifyFailure,
        outage: { enabled: true, recoveryCheck },
        operations: {},
      }),
    },
  });

  // The fetch failure should stay online until the async classifier settles.
  env.serverMock.setNextFetchError('boom');
  env.apiStore.scheduleFetch('highPriority');

  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'online'
    effectiveOffline: '❌'
    isLeader: '✅'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'outage-session'
    updatedAt: 1735689600000
  `);

  // Once the classifier resolves, the session should switch fully into outage mode.
  await advanceTime(25);

  expect(classifyFailure).toHaveBeenCalledTimes(1);
  expect(recoveryCheck).not.toHaveBeenCalled();

  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    isLeader: '✅'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: null
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'outage-session'
    updatedAt: 1735689600010
  `);

  expect(env.store.state.error).toMatchInlineSnapshot(`
    code: 0
    id: 'offline'
    message: 'Offline'
  `);
});

test('recovery probes back off and stop after a successful recovery check', async () => {
  const sessionKey = 'recovery-probe-session';
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
        classifyFailure: () => 'outage' as const,
        outage: {
          enabled: true,
          recoveryCheck,
          recoveryProbe: {
            initialIntervalMs: 100,
            maxIntervalMs: 400,
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
      `mode:${status.effectiveMode} outage:${status.outage.active ? 'on' : 'off'} probes:${probeCount}`,
    );
    return status;
  });

  // Start with a failed fetch so the recovery probe machinery has something to heal.
  env.serverMock.setNextFetchError('boom');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(25);

  expect(statusHook.result.current).toMatchInlineSnapshot(`
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    isLeader: '✅'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: null
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'recovery-probe-session'
    updatedAt: 1735689600010
  `);
  expect(recoveryCheck).toHaveBeenCalledTimes(0);

  // The first recovery probe should fail and keep the session in outage mode.
  env.addTimelineComments('beforeNextAction', [
    'wait for the first probe; it should fail and keep outage mode active',
  ]);
  await advanceTime(100);

  expect(recoveryCheck).toHaveBeenCalledTimes(1);

  expect(statusHook.result.current).toMatchInlineSnapshot(`
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    isLeader: '✅'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: 1735689600110
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'recovery-probe-session'
    updatedAt: 1735689600110
  `);

  // The next probe should succeed, clear outage mode, and stop the backoff loop.
  env.addTimelineComments('beforeNextAction', [
    'wait for the second probe; it should restore online mode',
  ]);
  await advanceTime(200);

  expect(recoveryCheck).toHaveBeenCalledTimes(2);

  expect(statusHook.result.current).toMatchInlineSnapshot(`
    effectiveMode: 'online'
    effectiveOffline: '❌'
    isLeader: '✅'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: 1735689600310
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '✅' }
    sessionKey: 'recovery-probe-session'
    updatedAt: 1735689600310
  `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                                |
    0     | "mode:online outage:off probes:0" | ui-initialized
    10ms  | "mode:online outage:off probes:0" | 🔴 >fetch-started
    .     | "mode:online outage:off probes:0" | 🔴 <fetch-error (value: "error")
    .     | "mode:offline outage:on probes:0" | ui-changed
    110ms | "mode:offline outage:on probes:0" | -- wait for the first probe; it should fail and keep outage mode active
    .     | "mode:offline outage:on probes:1" | ui-changed
    310ms | "mode:offline outage:on probes:1" | -- wait for the second probe; it should restore online mode
    .     | "mode:online outage:off probes:2" | ui-changed
    "
  `);
  statusHook.unmount();
});

test('default outage recovery probes use the slower backend-friendly cadence', async () => {
  const sessionKey = 'default-recovery-probe-session';
  let probeCount = 0;
  const recoveryCheck = vi.fn<
    ({ sessionKey }: { sessionKey: string }) => boolean
  >(({ sessionKey: resolvedSessionKey }) => {
    expect(resolvedSessionKey).toBe(sessionKey);
    probeCount += 1;
    return false;
  });
  const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: createOfflineConfigForSessionKey(() => sessionKey, {
        classifyFailure: () => 'outage' as const,
        outage: { enabled: true, recoveryCheck },
        operations: {},
      }),
    },
  });

  try {
    const statusHook = renderHook(() => {
      const status = useGlobalOfflineStatus(sessionKey);
      env.trackUIChanges(
        `mode:${status.effectiveMode} outage:${status.outage.active ? 'on' : 'off'} probes:${probeCount}`,
      );
      return status;
    });

    // Enter outage mode through a real fetch failure, then verify the built-in
    // recovery probe defaults wait longer before touching the backend again.
    env.serverMock.setNextFetchError('boom');
    env.apiStore.scheduleFetch('highPriority');
    await advanceTime(25);

    expect(recoveryCheck).toHaveBeenCalledTimes(0);

    env.addTimelineComments('beforeNextAction', [
      'the default outage recovery delay should avoid probing again before 30 seconds',
    ]);
    await advanceTime(29_000);

    expect(recoveryCheck).toHaveBeenCalledTimes(0);

    env.addTimelineComments('beforeNextAction', [
      'the first default outage recovery probe should run at 30 seconds',
    ]);
    await advanceTime(1_000);

    expect(recoveryCheck).toHaveBeenCalledTimes(1);
    expect(statusHook.result.current).toMatchInlineSnapshot(`
      effectiveMode: 'offline'
      effectiveOffline: '✅'
      isLeader: '✅'
      lastFailureAt: 1735689600010
      lastRecoveryCheckAt: 1735689630010
      network: { active: '❌', enabled: '❌' }
      outage: { active: '✅', enabled: '✅' }
      sessionKey: 'default-recovery-probe-session'
      updatedAt: 1735689630010
    `);

    env.addTimelineComments('beforeNextAction', [
      'the second default outage recovery probe should back off to 60 seconds',
    ]);
    await advanceTime(59_000);

    expect(recoveryCheck).toHaveBeenCalledTimes(1);

    await advanceTime(1_000);

    expect(recoveryCheck).toHaveBeenCalledTimes(2);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | ui                                |
      0      | "mode:online outage:off probes:0" | ui-initialized
      10ms   | "mode:online outage:off probes:0" | 🔴 >fetch-started
      .      | "mode:online outage:off probes:0" | 🔴 <fetch-error (value: "error")
      .      | "mode:offline outage:on probes:0" | ui-changed
      30.01s | "mode:offline outage:on probes:0" | -- the default outage recovery delay should avoid probing again before 30 seconds
      .      | "mode:offline outage:on probes:0" | -- the first default outage recovery probe should run at 30 seconds
      .      | "mode:offline outage:on probes:1" | ui-changed
      90.01s | "mode:offline outage:on probes:1" | -- the second default outage recovery probe should back off to 60 seconds
      .      | "mode:offline outage:on probes:2" | ui-changed
      "
    `);

    statusHook.unmount();
  } finally {
    randomSpy.mockRestore();
  }
});

test('recovery probes keep retrying after a rejected recovery check', async () => {
  const sessionKey = 'recovery-probe-reject-session';
  let probeCount = 0;
  const recoveryCheck = vi
    .fn<({ sessionKey }: { sessionKey: string }) => Promise<boolean>>()
    .mockImplementationOnce(({ sessionKey: resolvedSessionKey }) => {
      expect(resolvedSessionKey).toBe(sessionKey);
      probeCount += 1;
      return Promise.reject(new Error('probe failed'));
    })
    .mockImplementationOnce(({ sessionKey: resolvedSessionKey }) => {
      expect(resolvedSessionKey).toBe(sessionKey);
      probeCount += 1;
      return Promise.resolve(true);
    });

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: createOfflineConfigForSessionKey(() => sessionKey, {
        classifyFailure: () => 'outage' as const,
        outage: {
          enabled: true,
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
  const statusHook = renderHook(() => {
    const status = useGlobalOfflineStatus(sessionKey);
    env.trackUIChanges(
      `mode:${status.effectiveMode} outage:${status.outage.active ? 'on' : 'off'} probes:${probeCount}`,
    );
    return status;
  });

  // Trigger outage mode through a real fetch failure instead of toggling the
  // coordinator directly.
  env.serverMock.setNextFetchError('boom');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(25);

  expect(statusHook.result.current).toMatchInlineSnapshot(`
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    isLeader: '✅'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: null
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'recovery-probe-reject-session'
    updatedAt: 1735689600010
  `);
  expect(recoveryCheck).toHaveBeenCalledTimes(0);

  // A rejected probe should still record the attempt and keep the retry loop alive.
  env.addTimelineComments('beforeNextAction', [
    'the first recovery probe rejects, so outage mode should stay active and schedule another retry',
  ]);
  await advanceTime(60);

  expect(recoveryCheck).toHaveBeenCalledTimes(1);

  expect(statusHook.result.current).toMatchInlineSnapshot(`
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    isLeader: '✅'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: 1735689600060
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'recovery-probe-reject-session'
    updatedAt: 1735689600060
  `);

  // The next probe can still recover the session after the earlier rejection.
  env.addTimelineComments('beforeNextAction', [
    'the second recovery probe succeeds and should restore online mode',
  ]);
  await advanceTime(60);

  expect(recoveryCheck).toHaveBeenCalledTimes(2);

  expect(statusHook.result.current).toMatchInlineSnapshot(`
    effectiveMode: 'online'
    effectiveOffline: '❌'
    isLeader: '✅'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: 1735689600110
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '✅' }
    sessionKey: 'recovery-probe-reject-session'
    updatedAt: 1735689600110
  `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                                |
    0     | "mode:online outage:off probes:0" | ui-initialized
    10ms  | "mode:online outage:off probes:0" | 🔴 >fetch-started
    .     | "mode:online outage:off probes:0" | 🔴 <fetch-error (value: "error")
    .     | "mode:offline outage:on probes:0" | ui-changed
    60ms  | "mode:offline outage:on probes:0" | -- the first recovery probe rejects, so outage mode should stay active and schedule another retry
    .     | "mode:offline outage:on probes:1" | ui-changed
    110ms | "mode:offline outage:on probes:1" | -- the second recovery probe succeeds and should restore online mode
    .     | "mode:online outage:off probes:2" | ui-changed
    "
  `);
  statusHook.unmount();
});

// Protects against race conditions where a slow classifier could override a
// newer, already-settled classification.
test('stale async outage classifications are ignored after a newer failure settles first', async () => {
  const sessionKey = 'stale-outage-session';
  let resolveFirstClassification:
    | ((result: 'outage' | 'network' | 'ignore') => void)
    | undefined;
  const recoveryCheck = vi.fn(() => false);
  const classifyFailure = vi
    .fn<
      (
        error: unknown,
        ctx: {
          phase: 'fetch' | 'mutation' | 'sync';
          storeType: 'document' | 'collection' | 'listQuery';
          operationName?: string;
          sessionKey: string;
        },
      ) => Promise<'outage' | 'network' | 'ignore'>
    >()
    .mockImplementationOnce(
      (_error, ctx) =>
        new Promise<'outage' | 'network' | 'ignore'>((resolve) => {
          expect(ctx).toMatchInlineSnapshot(`
            phase: 'fetch'
            sessionKey: 'stale-outage-session'
            storeType: 'document'
          `);
          resolveFirstClassification = resolve;
        }),
    )
    .mockImplementationOnce((_error, ctx) => {
      expect(ctx).toMatchInlineSnapshot(`
        phase: 'fetch'
        sessionKey: 'stale-outage-session'
        storeType: 'document'
      `);
      return Promise.resolve('ignore' as const);
    });

  const createOfflineEnv = (storeName: string) =>
    createDocumentStoreTestEnv(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: createOfflineConfigForSessionKey(() => sessionKey, {
          classifyFailure,
          outage: { enabled: true, recoveryCheck },
          operations: {},
        }),
      },
    });

  const staleClassificationEnv = createOfflineEnv('stale-outage-doc-1');
  const newerFailureEnv = createOfflineEnv('stale-outage-doc-2');

  // The first failure begins an async classification that is intentionally left pending.
  staleClassificationEnv.serverMock.setNextFetchError('first failure');
  staleClassificationEnv.apiStore.scheduleFetch('highPriority');
  await advanceTime(25);
  await Promise.resolve();

  // A newer failure should settle first and keep the session online.
  newerFailureEnv.serverMock.setNextFetchError('second failure');
  newerFailureEnv.apiStore.scheduleFetch('highPriority');
  await advanceTime(25);
  await Promise.resolve();

  expect(classifyFailure).toHaveBeenCalledTimes(2);
  expect(recoveryCheck).not.toHaveBeenCalled();

  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'online'
    effectiveOffline: '❌'
    isLeader: '✅'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'stale-outage-session'
    updatedAt: 1735689600035
  `);
  expect(staleClassificationEnv.store.state.error?.id ?? null).not.toBe(
    'offline',
  );
  expect(newerFailureEnv.store.state.error?.id ?? null).not.toBe('offline');

  // Resolving the stale classifier must not retroactively flip either store into outage mode.
  resolveFirstClassification?.('outage');
  await Promise.resolve();
  await Promise.resolve();

  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'online'
    effectiveOffline: '❌'
    isLeader: '✅'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'stale-outage-session'
    updatedAt: 1735689600035
  `);
  expect(staleClassificationEnv.store.state.error?.id ?? null).not.toBe(
    'offline',
  );
  expect(newerFailureEnv.store.state.error?.id ?? null).not.toBe('offline');
});
