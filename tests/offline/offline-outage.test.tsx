import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type {
  OfflineHealthCheckContext,
  OfflineHealthCheckResult,
} from '../../src/main';
import { getGlobalOfflineStatus, useGlobalOfflineStatus } from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { DEFAULT_FETCH_DURATION_MS } from '../mocks/serverTableMock';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import {
  HEALTH_CHECK_DURATION_MS,
  createHealthCheckMock,
  createOfflineUsersEnv,
  getUsersErrors,
  healthRecoveryProbe,
  trackOfflineSession,
  userItemIds,
} from './offlineHealthCheckTestShared';
import {
  getOfflineQueueEntries,
  type UpdateValueExecuteContext,
  type UpdateValueOperations,
} from './offlineReplayTestShared';
import {
  docMutationInputSchema,
  docSchema,
  getGlobalOfflineStatusSummary,
  summarizeResolution,
} from './offlineTestShared';

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
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
        classifyFailure,
        outage: { enabled: true, recoveryCheck },
      },
    }),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {},
    },
  });

  // The fetch failure should stay online until the async classifier settles.
  env.serverMock.setNextFetchError('boom');
  env.apiStore.scheduleFetch('highPriority');

  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    isForcedOffline: '❌'
    isLeader: '✅'
    isOfflineMode: '❌'
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
    isForcedOffline: '❌'
    isLeader: '✅'
    isOfflineMode: '✅'
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
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
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
      },
    }),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {},
    },
  });
  const statusHook = renderHook(() => {
    const status = useGlobalOfflineStatus(sessionKey);
    env.trackUIChanges(
      `offlineMode:${status.isOfflineMode ? 'on' : 'off'} outage:${status.outage.active ? 'on' : 'off'} probes:${probeCount}`,
    );
    return status;
  });

  // Start with a failed fetch so the recovery probe machinery has something to heal.
  env.serverMock.setNextFetchError('boom');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(25);

  expect(statusHook.result.current).toMatchInlineSnapshot(`
    isForcedOffline: '❌'
    isLeader: '✅'
    isOfflineMode: '✅'
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
    isForcedOffline: '❌'
    isLeader: '✅'
    isOfflineMode: '✅'
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
    isForcedOffline: '❌'
    isLeader: '✅'
    isOfflineMode: '❌'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: 1735689600310
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '✅' }
    sessionKey: 'recovery-probe-session'
    updatedAt: 1735689600310
  `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                                    |
    0     | "offlineMode:off outage:off probes:0" | ui-initialized
    10ms  | "offlineMode:off outage:off probes:0" | 🔴 >fetch-started
    .     | "offlineMode:off outage:off probes:0" | 🔴 <fetch-error (value: "error")
    .     | "offlineMode:on outage:on probes:0"   | ui-changed
    110ms | "offlineMode:on outage:on probes:0"   | -- wait for the first probe; it should fail and keep outage mode active
    .     | "offlineMode:on outage:on probes:1"   | ui-changed
    310ms | "offlineMode:on outage:on probes:1"   | -- wait for the second probe; it should restore online mode
    .     | "offlineMode:off outage:off probes:2" | ui-changed
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
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
        classifyFailure: () => 'outage' as const,
        outage: { enabled: true, recoveryCheck },
      },
    }),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations: {} },
    },
  });

  try {
    const statusHook = renderHook(() => {
      const status = useGlobalOfflineStatus(sessionKey);
      env.trackUIChanges(
        `offlineMode:${status.isOfflineMode ? 'on' : 'off'} outage:${status.outage.active ? 'on' : 'off'} probes:${probeCount}`,
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
      isForcedOffline: '❌'
      isLeader: '✅'
      isOfflineMode: '✅'
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
      time   | ui                                    |
      0      | "offlineMode:off outage:off probes:0" | ui-initialized
      10ms   | "offlineMode:off outage:off probes:0" | 🔴 >fetch-started
      .      | "offlineMode:off outage:off probes:0" | 🔴 <fetch-error (value: "error")
      .      | "offlineMode:on outage:on probes:0"   | ui-changed
      30.01s | "offlineMode:on outage:on probes:0"   | -- the default outage recovery delay should avoid probing again before 30 seconds
      .      | "offlineMode:on outage:on probes:0"   | -- the first default outage recovery probe should run at 30 seconds
      .      | "offlineMode:on outage:on probes:1"   | ui-changed
      90.01s | "offlineMode:on outage:on probes:1"   | -- the second default outage recovery probe should back off to 60 seconds
      .      | "offlineMode:on outage:on probes:2"   | ui-changed
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
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
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
      `offlineMode:${status.isOfflineMode ? 'on' : 'off'} outage:${status.outage.active ? 'on' : 'off'} probes:${probeCount}`,
    );
    return status;
  });

  // Trigger outage mode through a real fetch failure instead of toggling the
  // coordinator directly.
  env.serverMock.setNextFetchError('boom');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(25);

  expect(statusHook.result.current).toMatchInlineSnapshot(`
    isForcedOffline: '❌'
    isLeader: '✅'
    isOfflineMode: '✅'
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
    isForcedOffline: '❌'
    isLeader: '✅'
    isOfflineMode: '✅'
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
    isForcedOffline: '❌'
    isLeader: '✅'
    isOfflineMode: '❌'
    lastFailureAt: 1735689600010
    lastRecoveryCheckAt: 1735689600110
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '✅' }
    sessionKey: 'recovery-probe-reject-session'
    updatedAt: 1735689600110
  `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                                    |
    0     | "offlineMode:off outage:off probes:0" | ui-initialized
    10ms  | "offlineMode:off outage:off probes:0" | 🔴 >fetch-started
    .     | "offlineMode:off outage:off probes:0" | 🔴 <fetch-error (value: "error")
    .     | "offlineMode:on outage:on probes:0"   | ui-changed
    60ms  | "offlineMode:on outage:on probes:0"   | -- the first recovery probe rejects, so outage mode should stay active and schedule another retry
    .     | "offlineMode:on outage:on probes:1"   | ui-changed
    110ms | "offlineMode:on outage:on probes:1"   | -- the second recovery probe succeeds and should restore online mode
    .     | "offlineMode:off outage:off probes:2" | ui-changed
    "
  `);
  statusHook.unmount();
});

// Sessions are torn down with `resetSessionForTests()` between tests and by
// restart-style tests. A recovery check still in flight at that moment used to
// re-arm the probe timer of the torn down session, which then kept probing
// forever inside whatever test was running next.
test('a session torn down while a recovery check is in flight stops probing', async () => {
  const sessionKey = 'recovery-probe-teardown-session';
  let answerRecoveryCheck: ((recovered: boolean) => void) | undefined;
  const recoveryCheck = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        answerRecoveryCheck = resolve;
      }),
  );

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
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
    }),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations: {} },
    },
  });

  // Enter outage mode through a real fetch failure.
  env.serverMock.setNextFetchError('boom');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(25);

  // The first recovery check starts and is left waiting for the backend.
  await advanceTime(100);
  expect(recoveryCheck).toHaveBeenCalledTimes(1);

  // The session is torn down while that check is still in flight...
  resetSessionForTests();

  // ...and only then the backend answers that it is still down.
  answerRecoveryCheck?.(false);
  await advanceTime(1_000);

  // The torn down session must not schedule another probe.
  expect(recoveryCheck).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
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
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
          classifyFailure,
          outage: { enabled: true, recoveryCheck },
        },
      }),
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: { operations: {} },
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
    isForcedOffline: '❌'
    isLeader: '✅'
    isOfflineMode: '❌'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'stale-outage-session'
    updatedAt: 1735689600000
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
    isForcedOffline: '❌'
    isLeader: '✅'
    isOfflineMode: '❌'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'stale-outage-session'
    updatedAt: 1735689600000
  `);
  expect(staleClassificationEnv.store.state.error?.id ?? null).not.toBe(
    'offline',
  );
  expect(newerFailureEnv.store.state.error?.id ?? null).not.toBe('offline');
});

// ---------------------------------------------------------------------------
// `offlineSession.healthCheck`: one health check answers both "this request
// failed: is it the network, an outage, or just this request?" and "are we
// back?". The app wires its health endpoint once instead of in several hooks.
// ---------------------------------------------------------------------------

test('a burst of requests failing while the backend is down costs one health check and enters outage mode', async () => {
  const sessionKey = 'health-check-outage-burst-session';
  const health = createHealthCheckMock();
  const env = createOfflineUsersEnv(sessionKey, {
    healthCheck: { check: health.check },
    outage: { enabled: true },
  });
  const session = trackOfflineSession(sessionKey, health);

  // -- The backend goes down while a screen is loading --
  // The three item requests are refused right away, the list request only
  // fails after hanging for its whole duration.
  health.setBackend('outage');
  env.serverTable.setNextListFetchError('gateway timeout');
  env.scheduleFetch('highPriority', { tableId: 'users' });
  for (const itemId of userItemIds) {
    env.serverTable.setNextFetchError(itemId, 'bad gateway');
    env.scheduleItemFetch('highPriority', itemId);
  }

  // -- The item requests have failed and the health request is in flight --
  await advanceTime(50);

  // Three failures, a single health request: the failures share it.
  expect(health.check).toHaveBeenCalledTimes(1);
  // The check receives the session it runs for and a live abort signal.
  const healthCheckCtx = health.check.mock.calls[0]?.[0];
  expect({
    sessionKey: healthCheckCtx?.sessionKey,
    aborted: healthCheckCtx?.signal.aborted,
  }).toMatchInlineSnapshot(`
    aborted: '❌'
    sessionKey: 'health-check-outage-burst-session'
  `);
  // Nothing is decided before the health endpoint answers.
  expect(getGlobalOfflineStatusSummary(sessionKey).isOfflineMode).toBe(false);

  // -- The health endpoint answers "outage" --
  session.log.addMark('the health endpoint answers "outage"');
  await advanceTime(HEALTH_CHECK_DURATION_MS);

  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'health-check-outage-burst-session'
  `);

  // -- The list request fails later, with the outage already known --
  session.log.addMark('the list request fails after the outage is known');
  await advanceTime(DEFAULT_FETCH_DURATION_MS);

  // A failure that arrives while the session is already in offline mode is
  // explained by it: no extra health request.
  expect(health.check).toHaveBeenCalledTimes(1);

  // Every request of the burst reports the offline state, not its own error.
  expect(getUsersErrors(env)).toMatchInlineSnapshot(`
    items: ['Offline', 'Offline', 'Offline']
    list: 'Offline'
  `);
  expect(session.log.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> at: 0ms ⋅ session: online ⋅ healthChecks: 0

    >>> the health endpoint answers "outage"

    -> at: 110ms ⋅ session: offline (outage) ⋅ healthChecks: 1

    >>> the list request fails after the outage is known
    "
  `);

  session.unmount();
});

test('a healthy backend leaves the session online, each failed request shows its own error and the answer is not reused', async () => {
  const sessionKey = 'health-check-up-session';
  const health = createHealthCheckMock();
  const env = createOfflineUsersEnv(sessionKey, {
    healthCheck: { check: health.check },
    outage: { enabled: true },
  });
  const session = trackOfflineSession(sessionKey, health);

  // -- Three item requests fail while the backend is healthy --
  for (const itemId of userItemIds) {
    env.serverTable.setNextFetchError(itemId, `${itemId} not found`);
    env.scheduleItemFetch('highPriority', itemId);
  }
  await advanceTime(50 + HEALTH_CHECK_DURATION_MS);

  // One health request for the three failures. It answered "up", so the
  // failures belong to their requests: the session stays online and every
  // item shows its own error.
  expect(health.check).toHaveBeenCalledTimes(1);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'health-check-up-session'
  `);
  expect(getUsersErrors(env)).toMatchInlineSnapshot(`
    items: ['users||1 not found', 'users||2 not found', 'users||3 not found']
    list: null
  `);

  // -- Right after that answer the backend really goes down --
  session.log.addMark('the backend goes down right after answering "up"');
  health.setBackend('outage');
  env.serverTable.setNextFetchError('users||1', 'bad gateway');
  env.scheduleItemFetch('highPriority', 'users||1');
  await advanceTime(50 + HEALTH_CHECK_DURATION_MS);

  // The "up" answer from a moment ago is not reused, otherwise it would hide
  // the outage: this failure runs its own health request and finds it.
  expect(health.check).toHaveBeenCalledTimes(2);
  expect(getUsersErrors(env)).toMatchInlineSnapshot(`
    items: ['Offline', 'users||2 not found', 'users||3 not found']
    list: null
  `);
  expect(session.log.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> at: 0ms ⋅ session: online ⋅ healthChecks: 0

    >>> the backend goes down right after answering "up"

    -> at: 260ms ⋅ session: offline (outage) ⋅ healthChecks: 2
    "
  `);

  session.unmount();
});

// Real case: the app's health check costs several API requests. One endpoint
// keeps answering 500 while the API is up, and without reuse every one of its
// failures would cost a full health check while the backend is degraded.
test('with reuseUpForFailuresMs, an endpoint that keeps failing while the backend is up costs one health check per reuse window', async () => {
  const sessionKey = 'health-check-reuse-up-session';
  const health = createHealthCheckMock();
  const env = createOfflineUsersEnv(sessionKey, {
    healthCheck: { check: health.check, reuseUpForFailuresMs: 30_000 },
    outage: { enabled: true },
  });
  const failures = createLoggerStore();

  async function failUser1Fetch(error: string) {
    env.serverTable.setNextFetchError('users||1', error);
    env.scheduleItemFetch('highPriority', 'users||1');
    await advanceTime(50 + HEALTH_CHECK_DURATION_MS);
    failures.add({
      at: `${Date.now() - TEST_INITIAL_TIME}ms`,
      itemError: env.getItemQueryState('users||1')?.error?.message ?? null,
      healthChecks: health.check.mock.calls.length,
    });
  }

  // -- 1st failure: the health check answers "up" and starts the window --
  failures.addMark('1st failure asks the health check');
  await failUser1Fetch('internal error #1');

  // -- The same endpoint keeps failing inside the 30s window --
  failures.addMark('failures inside the window reuse the "up" answer');
  await advanceTime(10_000);
  await failUser1Fetch('internal error #2');
  await advanceTime(10_000);
  await failUser1Fetch('internal error #3');

  // -- The window is over: the next failure asks again --
  failures.addMark('the window is over: the next failure asks again');
  await advanceTime(10_000);
  await failUser1Fetch('internal error #4');

  // Each failure shows its own error, the session never goes offline, and
  // the three failures of the window cost a single health check.
  expect(failures.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> 1st failure asks the health check

    -> at: 150ms ⋅ itemError: internal error #1 ⋅ healthChecks: 1

    >>> failures inside the window reuse the "up" answer

    -> at: 10300ms ⋅ itemError: internal error #2 ⋅ healthChecks: 1
    -> at: 20450ms ⋅ itemError: internal error #3 ⋅ healthChecks: 1

    >>> the window is over: the next failure asks again

    -> at: 30600ms ⋅ itemError: internal error #4 ⋅ healthChecks: 2
    "
  `);
  expect(getGlobalOfflineStatusSummary(sessionKey).isOfflineMode).toBe(false);
});

test('a reused "up" never decides recovery: entering outage mode drops it and recovery checks always ask the health endpoint', async () => {
  const sessionKey = 'health-check-reuse-up-recovery-session';
  const health = createHealthCheckMock();
  const env = createOfflineUsersEnv(sessionKey, {
    // The app recognizes a 503 as an outage from the error alone and defers
    // every other failure to the health check.
    classifyFailure: (error) =>
      error instanceof Error && error.message === 'service unavailable'
        ? 'outage'
        : 'unknown',
    healthCheck: { check: health.check, reuseUpForFailuresMs: 30_000 },
    outage: { enabled: true, recoveryProbe: healthRecoveryProbe },
  });
  const session = trackOfflineSession(sessionKey, health);

  async function failItemFetch(itemId: string, error: string) {
    env.serverTable.setNextFetchError(itemId, error);
    env.scheduleItemFetch('highPriority', itemId);
    await advanceTime(50 + HEALTH_CHECK_DURATION_MS);
  }

  // -- A failure while the backend is up: the reuse window starts --
  session.log.addMark('a failure is answered "up"');
  await failItemFetch('users||1', 'internal error');
  expect(health.check).toHaveBeenCalledTimes(1);

  // -- A moment later the backend goes down and a request reports it --
  session.log.addMark('a 503 puts the session in outage mode');
  health.setBackend('outage');
  await failItemFetch('users||2', 'service unavailable');
  // `classifyFailure` answered on its own: no health request.
  expect(health.check).toHaveBeenCalledTimes(1);

  // -- The recovery check runs 1s after the "up", well inside its 30s --
  session.log.addMark('recovery check 1s after the "up"');
  await advanceTime(
    healthRecoveryProbe.initialIntervalMs + HEALTH_CHECK_DURATION_MS,
  );

  // Entering outage mode dropped the "up" from a second ago, so the recovery
  // check had nothing to reuse: it asked the health endpoint, and the outage
  // is still active.
  expect(health.check).toHaveBeenCalledTimes(2);
  expect(getGlobalOfflineStatusSummary(sessionKey).outage)
    .toMatchInlineSnapshot(`
      active: '✅'
      enabled: '✅'
    `);

  // -- The backend comes back: the next recovery check ends the outage --
  session.log.addMark('the backend is back');
  health.setBackend('up');
  await advanceTime(
    healthRecoveryProbe.initialIntervalMs + HEALTH_CHECK_DURATION_MS,
  );
  expect(health.check).toHaveBeenCalledTimes(3);

  // -- A failure right after recovering --
  session.log.addMark('a failure right after recovering asks again');
  await failItemFetch('users||1', 'internal error');

  // The window ended when the session entered outage mode, and the
  // recovery check's "up" does not start a new one: the failure asks.
  expect(health.check).toHaveBeenCalledTimes(4);

  // -- That answer starts a new window for the next failures --
  session.log.addMark('the next failure reuses that answer');
  await failItemFetch('users||3', 'internal error');
  expect(health.check).toHaveBeenCalledTimes(4);
  // The failures answered "up" show their own error; users||2 failed during
  // the outage and shows the offline error.
  expect(getUsersErrors(env)).toMatchInlineSnapshot(`
    items: ['internal error', 'Offline', 'internal error']
    list: null
  `);
  expect(session.log.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> at: 0ms ⋅ session: online ⋅ healthChecks: 0

    >>> a failure is answered "up"

    >>> a 503 puts the session in outage mode

    -> at: 160ms ⋅ session: offline (outage) ⋅ healthChecks: 1

    >>> recovery check 1s after the "up"

    -> at: 1260ms ⋅ session: offline (outage) ⋅ healthChecks: 2

    >>> the backend is back

    -> at: 2360ms ⋅ session: online ⋅ healthChecks: 3

    >>> a failure right after recovering asks again

    >>> the next failure reuses that answer
    "
  `);

  session.unmount();
});

// Real case: the endpoint a queued mutation depends on (an upload service)
// answers 503 while the API health check passes. "up" means the failure is
// specific to that request, so the session must not go offline for it.
test('a replayed mutation that keeps failing while the health check answers "up" uses its retry budget and ends in a retry-exhausted resolution', async () => {
  const sessionKey = 'health-check-up-replay-session';
  const storeName = 'health-check-up-replay-doc';
  // The health endpoint answers "up" during the whole test.
  const health = createHealthCheckMock();
  const network = createOfflineNetworkMock();
  network.install();
  const execute = vi.fn<
    (ctx: UpdateValueExecuteContext) => Promise<{ value: number }>
  >(() => Promise.reject(new Error('upload service unavailable (503)')));

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: storeName,
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
        healthCheck: { check: health.check },
        network: network.config,
        outage: { enabled: true },
        // Re-sending the mutation is safe, with a budget of 2 attempts.
        classifyRetryableFailure: () => true,
        replayRetry: { maxFailures: 2, intervalMs: 1_000 },
      },
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
            execute,
            onSuccessExecute: () => {},
          },
        },
      },
    },
  });
  const session = trackOfflineSession(sessionKey, health);

  // -- The mutation is queued while the browser is offline --
  act(() => {
    network.goOffline();
  });
  await act(async () => {
    await env.apiStore.performMutation({
      mutation: () => Promise.reject(new Error('not sent while offline')),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });
  });
  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);

  // -- Back online: the 1st replay attempt fails with the 503 --
  session.log.addMark('back online: 1st replay attempt fails');
  act(() => {
    network.goOnline();
  });
  await advanceTime(50 + HEALTH_CHECK_DURATION_MS);

  // The failure asked the health check, which answered "up": the session
  // stays online and the mutation waits for its next attempt.
  expect(execute).toHaveBeenCalledTimes(1);
  expect(health.check).toHaveBeenCalledTimes(1);
  expect(getGlobalOfflineStatusSummary(sessionKey).isOfflineMode).toBe(false);

  // -- The 2nd attempt fails too: the retry budget is spent --
  session.log.addMark('2nd replay attempt fails: retry budget spent');
  await advanceTime(1_000 + HEALTH_CHECK_DURATION_MS);
  await flushAllTimers();

  // The mutation's own failure handling applied: it left the queue as a
  // `retry-exhausted` resolution for the user to retry or discard.
  expect(execute).toHaveBeenCalledTimes(2);
  expect(env.apiStore.getOfflineResolutions().map(summarizeResolution))
    .toMatchInlineSnapshot(`
      - error: 'upload service unavailable (503)'
        input: 'value: 2'
        kind: 'retry-exhausted'
        on: 'document:document'
        op: 'updateValue'
    `);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(0);

  // One health check per failed attempt, and the session never went offline
  // because of them: the only offline period is the browser one.
  expect(health.check).toHaveBeenCalledTimes(2);
  expect(session.log.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> at: 0ms ⋅ session: online ⋅ healthChecks: 0
    -> at: 0ms ⋅ session: offline (network) ⋅ healthChecks: 0

    >>> back online: 1st replay attempt fails

    -> at: 0ms ⋅ session: online ⋅ healthChecks: 0

    >>> 2nd replay attempt fails: retry budget spent
    "
  `);

  session.unmount();
});

test('recovery checks use the same health check: the outage ends when it answers "up" and the queued mutation is sent', async () => {
  const sessionKey = 'health-check-outage-recovery-session';
  const storeName = 'health-check-outage-recovery-doc';
  const health = createHealthCheckMock();
  const replayedInputs: { value: number }[] = [];

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: storeName,
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
        // No `outage.recoveryCheck` and no `classifyFailure`: the health
        // check is the only thing the app wires.
        healthCheck: { check: health.check },
        outage: { enabled: true, recoveryProbe: healthRecoveryProbe },
      },
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
  const session = trackOfflineSession(sessionKey, health);

  // -- The backend goes down: a mutation and a refetch fail together --
  health.setBackend('outage');
  const mutationPromise = env.apiStore.performMutation({
    optimisticUpdate: () => {
      env.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: () => Promise.reject(new Error('bad gateway')),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });
  env.serverMock.setNextFetchError('bad gateway');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(50 + HEALTH_CHECK_DURATION_MS);
  const mutationResult = await mutationPromise;

  // Both failures were classified by one health request: the mutation went
  // to the offline queue instead of failing.
  expect(health.check).toHaveBeenCalledTimes(1);
  expect(mutationResult.ok && mutationResult.value).toMatchInlineSnapshot(
    `kind: 'queued'`,
  );
  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);

  // -- First recovery check: the backend is still down --
  session.log.addMark('1st recovery check: still down');
  await advanceTime(
    healthRecoveryProbe.initialIntervalMs + HEALTH_CHECK_DURATION_MS,
  );

  expect(health.check).toHaveBeenCalledTimes(2);
  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    isForcedOffline: '❌'
    isLeader: '✅'
    isOfflineMode: '✅'
    lastFailureAt: 1735689600100
    lastRecoveryCheckAt: 1735689601200
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'health-check-outage-recovery-session'
    updatedAt: 1735689601200
  `);
  expect(replayedInputs).toMatchInlineSnapshot(`[]`);

  // -- The backend comes back: the next recovery check sees it --
  session.log.addMark('2nd recovery check: the backend is back');
  health.setBackend('up');
  await advanceTime(
    healthRecoveryProbe.initialIntervalMs + HEALTH_CHECK_DURATION_MS,
  );
  await flushAllTimers();

  // The same health check ended the outage, then the queued mutation was
  // replayed.
  expect(health.check).toHaveBeenCalledTimes(3);
  expect(replayedInputs).toMatchInlineSnapshot(`- value: 2`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(0);
  expect(env.serverMock.current).toBe(2);

  // Recovering stops the checks: nothing runs on the success path.
  await advanceTime(10 * healthRecoveryProbe.initialIntervalMs);
  expect(health.check).toHaveBeenCalledTimes(3);
  expect(session.log.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> at: 0ms ⋅ session: online ⋅ healthChecks: 0
    -> at: 100ms ⋅ session: offline (outage) ⋅ healthChecks: 1

    >>> 1st recovery check: still down

    -> at: 1200ms ⋅ session: offline (outage) ⋅ healthChecks: 2

    >>> 2nd recovery check: the backend is back

    -> at: 2300ms ⋅ session: online ⋅ healthChecks: 3
    "
  `);

  session.unmount();
});

test('classifyFailure answers win over the health check, which only runs for failures classified as unknown', async () => {
  const sessionKey = 'health-check-precedence-session';
  const health = createHealthCheckMock();
  // The app can tell some failures apart from the error alone and only needs
  // the health endpoint for the ambiguous ones.
  const classifyFailure = vi.fn((error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    if (message === 'validation failed') return 'ignore' as const;
    if (message === 'service unavailable') return 'outage' as const;
    return 'unknown' as const;
  });
  // The outage mode has its own recovery probe, which wins over the health
  // check for outage recovery.
  const outageRecoveryCheck = vi.fn(() => true);

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
        classifyFailure,
        healthCheck: { check: health.check },
        outage: {
          enabled: true,
          recoveryCheck: outageRecoveryCheck,
          recoveryProbe: healthRecoveryProbe,
        },
      },
    }),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {},
    },
  });
  const session = trackOfflineSession(sessionKey, health);

  async function failFetchWith(message: string) {
    session.log.addMark(`a fetch fails with "${message}"`);
    env.serverMock.setNextFetchError(message);
    env.apiStore.scheduleFetch('highPriority');
    await advanceTime(50 + HEALTH_CHECK_DURATION_MS);

    return env.store.state.error?.message ?? null;
  }

  // -- `ignore` is final: no health request, the fetch shows its error --
  expect(await failFetchWith('validation failed')).toBe('validation failed');
  expect(health.check).toHaveBeenCalledTimes(0);

  // -- `unknown` asks the health check, which says the backend is fine --
  expect(await failFetchWith('request timed out')).toBe('request timed out');
  expect(health.check).toHaveBeenCalledTimes(1);

  // -- `outage` is final: outage mode without a health request --
  expect(await failFetchWith('service unavailable')).toBe('Offline');
  expect(health.check).toHaveBeenCalledTimes(1);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'health-check-precedence-session'
  `);

  // -- Outage recovery uses `outage.recoveryCheck`, not the health check --
  session.log.addMark('outage recovery probe');
  await advanceTime(healthRecoveryProbe.initialIntervalMs);

  expect(outageRecoveryCheck).toHaveBeenCalledTimes(1);
  expect(health.check).toHaveBeenCalledTimes(1);
  expect(session.log.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> at: 0ms ⋅ session: online ⋅ healthChecks: 0

    >>> a fetch fails with "validation failed"

    >>> a fetch fails with "request timed out"

    >>> a fetch fails with "service unavailable"

    -> at: 310ms ⋅ session: offline (outage) ⋅ healthChecks: 1

    >>> outage recovery probe

    -> at: 1310ms ⋅ session: online ⋅ healthChecks: 1
    "
  `);

  session.unmount();
});

test('the health check is never requested while the session gate is closed', async () => {
  const sessionKey = 'health-check-gate-session';
  const health = createHealthCheckMock();
  // The backend is down the whole time; only the gate changes.
  health.setBackend('outage');
  let isOfflineLayerEnabled = false;

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
        enabled: () => isOfflineLayerEnabled,
        healthCheck: { check: health.check },
        outage: { enabled: true },
      },
    }),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {},
    },
  });

  // -- Gate closed: a failed fetch is a plain failed fetch --
  env.serverMock.setNextFetchError('bad gateway');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(50 + HEALTH_CHECK_DURATION_MS);

  expect(health.check).not.toHaveBeenCalled();
  expect(env.store.state.error?.message).toBe('bad gateway');
  expect(getGlobalOfflineStatusSummary(sessionKey).isOfflineMode).toBe(false);

  // -- Gate open: the same failure is now classified by the health check --
  isOfflineLayerEnabled = true;
  env.serverMock.setNextFetchError('bad gateway');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(50 + HEALTH_CHECK_DURATION_MS);

  expect(health.check).toHaveBeenCalledTimes(1);
  expect(env.store.state.error?.message).toBe('Offline');
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'health-check-gate-session'
  `);

  // -- Gate closed again while in outage mode: recovery checks stop too --
  isOfflineLayerEnabled = false;
  env.serverMock.setNextFetchError('bad gateway');
  env.apiStore.scheduleFetch('highPriority');
  // Well past the default outage recovery cadence (30s).
  await advanceTime(120_000);

  expect(health.check).toHaveBeenCalledTimes(1);
  expect(env.store.state.error?.message).toBe('bad gateway');
  expect(getGlobalOfflineStatusSummary(sessionKey).isOfflineMode).toBe(false);
});

test('an outage answer is ignored while outage mode is disabled at runtime', async () => {
  const sessionKey = 'health-check-outage-disabled-session';
  const health = createHealthCheckMock();
  health.setBackend('outage');
  const network = createOfflineNetworkMock();

  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: {
      healthCheck: { check: health.check },
      network: network.config,
      outage: { enabled: true },
    },
  });
  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    storeManager,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {},
    },
  });

  // -- The app turns outage handling off; network mode stays enabled --
  storeManager.setOfflineRuntimeConfig({ outage: { enabled: false } }).unwrap();

  env.serverMock.setNextFetchError('bad gateway');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(50 + HEALTH_CHECK_DURATION_MS);

  // The health check ran (the failure could have been a network problem) but
  // its "outage" answer cannot activate a disabled mode.
  expect(health.check).toHaveBeenCalledTimes(1);
  expect(env.store.state.error?.message).toBe('bad gateway');
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'health-check-outage-disabled-session'
  `);

  // -- Outage handling is turned back on --
  storeManager.resetOfflineRuntimeConfig();

  env.serverMock.setNextFetchError('bad gateway');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(50 + HEALTH_CHECK_DURATION_MS);

  expect(health.check).toHaveBeenCalledTimes(2);
  expect(env.store.state.error?.message).toBe('Offline');
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '❌', enabled: '✅' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'health-check-outage-disabled-session'
  `);
});

test('a health check that throws or never answers leaves the failure to its request instead of blocking it', async () => {
  const sessionKey = 'health-check-broken-classification-session';
  const health = createHealthCheckMock();
  health.setBackend('outage');
  let hangingCheckSignal: AbortSignal | undefined;

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
        healthCheck: { check: health.check, timeoutMs: 5_000 },
        outage: { enabled: true },
      },
    }),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {},
    },
  });
  // What the user sees for the document, with the time of each change.
  const renders = createLoggerStore();
  const documentHook = renderHook(() => {
    const doc = env.apiStore.useDocument({ returnRefetchingStatus: true });
    renders.add({
      at: `${Date.now() - TEST_INITIAL_TIME}ms`,
      status: doc.status,
      error: doc.error?.message,
    });
  });

  // -- 1st failure (the fetch of the mounted document): the health check
  // itself throws --
  renders.addMark('1st failure: the health check throws');
  health.check.mockImplementationOnce(() =>
    Promise.reject(new Error('health endpoint misconfigured')),
  );
  env.serverMock.setNextFetchError('bad gateway');
  await advanceTime(50);

  // No answer means no evidence: the session stays online and the fetch
  // fails with its own error.
  expect(getGlobalOfflineStatusSummary(sessionKey).isOfflineMode).toBe(false);

  // -- 2nd failure: the health request hangs forever --
  renders.addMark('2nd failure: the health request never answers');
  health.check.mockImplementationOnce(
    ({ signal }: OfflineHealthCheckContext) => {
      hangingCheckSignal = signal;
      return new Promise<OfflineHealthCheckResult>(() => {});
    },
  );
  env.serverMock.setNextFetchError('bad gateway');
  env.apiStore.scheduleFetch('highPriority');
  // The fetch fails and the health request starts a few ms from now.
  await advanceTime(4_500);

  // Still inside `timeoutMs` (5s): the fetch waits for the classification.
  expect(hangingCheckSignal?.aborted).toBe(false);

  renders.addMark('the health check times out');
  await advanceTime(1_000);

  // The session gave up on the check and told it so through the signal.
  expect(hangingCheckSignal?.aborted).toBe(true);
  expect(getGlobalOfflineStatusSummary(sessionKey).isOfflineMode).toBe(false);

  // -- 3rd failure: the health check works again --
  renders.addMark('3rd failure: the health check answers "outage"');
  env.serverMock.setNextFetchError('bad gateway');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(50 + HEALTH_CHECK_DURATION_MS);

  // The session is not stuck on the hung request: a new check ran.
  expect(health.check).toHaveBeenCalledTimes(3);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'health-check-broken-classification-session'
  `);
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> at: 0ms ⋅ status: loading ⋅ error: undefined

    >>> 1st failure: the health check throws

    -> at: 10ms ⋅ status: error ⋅ error: bad gateway

    >>> 2nd failure: the health request never answers

    -> at: 60ms ⋅ status: loading ⋅ error: undefined

    >>> the health check times out

    -> at: 5060ms ⋅ status: error ⋅ error: bad gateway

    >>> 3rd failure: the health check answers "outage"

    -> at: 5560ms ⋅ status: loading ⋅ error: undefined
    -> at: 5660ms ⋅ status: error ⋅ error: Offline
    "
  `);

  documentHook.unmount();
});

test('a health check that throws or never answers during recovery keeps the outage and the next check can still end it', async () => {
  const sessionKey = 'health-check-broken-recovery-session';
  const health = createHealthCheckMock();
  health.setBackend('outage');

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
        healthCheck: { check: health.check, timeoutMs: 5_000 },
        outage: { enabled: true, recoveryProbe: healthRecoveryProbe },
      },
    }),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {},
    },
  });
  const session = trackOfflineSession(sessionKey, health);

  // -- Enter outage mode through a failed fetch --
  env.serverMock.setNextFetchError('bad gateway');
  env.apiStore.scheduleFetch('highPriority');
  await advanceTime(50 + HEALTH_CHECK_DURATION_MS);
  expect(getGlobalOfflineStatusSummary(sessionKey).isOfflineMode).toBe(true);

  // The backend is back from here on, but the health check misbehaves first.
  health.setBackend('up');

  // -- 1st recovery check throws --
  session.log.addMark('1st recovery check throws');
  health.check.mockImplementationOnce(() => {
    throw new Error('health endpoint misconfigured');
  });
  await advanceTime(healthRecoveryProbe.initialIntervalMs);

  // No answer is not a recovery: the outage stays.
  expect(health.check).toHaveBeenCalledTimes(2);
  expect(getGlobalOfflineStatusSummary(sessionKey).isOfflineMode).toBe(true);

  // -- 2nd recovery check never answers --
  session.log.addMark('2nd recovery check never answers');
  health.check.mockImplementationOnce(
    () => new Promise<OfflineHealthCheckResult>(() => {}),
  );
  await advanceTime(healthRecoveryProbe.initialIntervalMs);
  expect(health.check).toHaveBeenCalledTimes(3);

  // It is abandoned after `timeoutMs`, with the outage still active...
  await advanceTime(5_000);
  expect(getGlobalOfflineStatusSummary(sessionKey).isOfflineMode).toBe(true);

  // -- 3rd recovery check answers "up" --
  // ...and the recovery loop goes on: the next check ends the outage.
  session.log.addMark('3rd recovery check answers "up"');
  await advanceTime(
    healthRecoveryProbe.initialIntervalMs + HEALTH_CHECK_DURATION_MS,
  );

  expect(health.check).toHaveBeenCalledTimes(4);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '✅' }
    sessionKey: 'health-check-broken-recovery-session'
  `);
  expect(session.log.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> at: 0ms ⋅ session: online ⋅ healthChecks: 0
    -> at: 110ms ⋅ session: offline (outage) ⋅ healthChecks: 1

    >>> 1st recovery check throws

    -> at: 1110ms ⋅ session: offline (outage) ⋅ healthChecks: 2

    >>> 2nd recovery check never answers

    -> at: 7110ms ⋅ session: offline (outage) ⋅ healthChecks: 3

    >>> 3rd recovery check answers "up"

    -> at: 8210ms ⋅ session: online ⋅ healthChecks: 4
    "
  `);

  session.unmount();
});
