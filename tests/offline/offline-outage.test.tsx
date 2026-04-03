import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { getGlobalOfflineStatus, useGlobalOfflineStatus } from '../../src/main';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
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
      expect(ctx).toMatchObject({
        phase: 'fetch',
        operationName: undefined,
        sessionKey,
        storeType: 'document',
      });

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
      offlineMode: {
        outage: { enabled: true, classifyFailure, recoveryCheck },
        operations: {},
      },
    },
  });

  // The fetch failure should stay online until the async classifier settles.
  env.serverMock.setNextFetchError('boom');
  env.apiStore.scheduleFetch('highPriority');
  expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
    effectiveMode: 'online',
    effectiveOffline: false,
    outage: { active: false },
  });

  // Once the classifier resolves, the session should switch fully into outage mode.
  await advanceTime(25);

  expect(classifyFailure).toHaveBeenCalledTimes(1);
  expect(recoveryCheck).not.toHaveBeenCalled();
  expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
    effectiveMode: 'offline',
    effectiveOffline: true,
    network: { active: false, enabled: false },
    outage: { active: true, enabled: true },
    lastFailureAt: expect.any(Number),
    lastRecoveryCheckAt: null,
    sessionKey,
  });
  expect(env.store.state.error).toEqual({
    code: 0,
    id: 'offline',
    message: 'Offline',
  });
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
      offlineMode: {
        outage: {
          enabled: true,
          classifyFailure: () => 'outage' as const,
          recoveryCheck,
          recoveryProbe: {
            intervalMs: 100,
            maxIntervalMs: 400,
            backoffMultiplier: 2,
            jitterRatio: 0,
          },
        },
        operations: {},
      },
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

  expect(statusHook.result.current).toMatchObject({
    effectiveMode: 'offline',
    effectiveOffline: true,
    outage: { active: true, enabled: true },
  });
  expect(recoveryCheck).toHaveBeenCalledTimes(0);

  // The first recovery probe should fail and keep the session in outage mode.
  env.addTimelineComments('beforeNextAction', [
    'wait for the first probe; it should fail and keep outage mode active',
  ]);
  await advanceTime(100);

  expect(recoveryCheck).toHaveBeenCalledTimes(1);
  expect(statusHook.result.current).toMatchObject({
    effectiveMode: 'offline',
    effectiveOffline: true,
    outage: { active: true, enabled: true },
  });

  // The next probe should succeed, clear outage mode, and stop the backoff loop.
  env.addTimelineComments('beforeNextAction', [
    'wait for the second probe; it should restore online mode',
  ]);
  await advanceTime(200);

  expect(recoveryCheck).toHaveBeenCalledTimes(2);
  expect(statusHook.result.current).toMatchObject({
    effectiveMode: 'online',
    effectiveOffline: false,
    outage: { active: false, enabled: true },
    lastRecoveryCheckAt: expect.any(Number),
  });
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
      offlineMode: {
        outage: {
          enabled: true,
          classifyFailure: () => 'outage' as const,
          recoveryCheck,
          recoveryProbe: {
            intervalMs: 50,
            maxIntervalMs: 50,
            backoffMultiplier: 1,
            jitterRatio: 0,
          },
        },
        operations: {},
      },
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

  expect(statusHook.result.current).toMatchObject({
    effectiveMode: 'offline',
    effectiveOffline: true,
    outage: { active: true, enabled: true },
  });
  expect(recoveryCheck).toHaveBeenCalledTimes(0);

  // A rejected probe should still record the attempt and keep the retry loop alive.
  env.addTimelineComments('beforeNextAction', [
    'the first recovery probe rejects, so outage mode should stay active and schedule another retry',
  ]);
  await advanceTime(60);

  expect(recoveryCheck).toHaveBeenCalledTimes(1);
  expect(statusHook.result.current).toMatchObject({
    effectiveMode: 'offline',
    effectiveOffline: true,
    outage: { active: true, enabled: true },
    lastRecoveryCheckAt: expect.any(Number),
  });

  // The next probe can still recover the session after the earlier rejection.
  env.addTimelineComments('beforeNextAction', [
    'the second recovery probe succeeds and should restore online mode',
  ]);
  await advanceTime(60);

  expect(recoveryCheck).toHaveBeenCalledTimes(2);
  expect(statusHook.result.current).toMatchObject({
    effectiveMode: 'online',
    effectiveOffline: false,
    outage: { active: false, enabled: true },
    lastRecoveryCheckAt: expect.any(Number),
  });
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
    | ((result: 'outage' | 'ignore') => void)
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
      ) => Promise<'outage' | 'ignore'>
    >()
    .mockImplementationOnce(
      (_error, ctx) =>
        new Promise<'outage' | 'ignore'>((resolve) => {
          expect(ctx).toMatchObject({
            phase: 'fetch',
            sessionKey,
            storeType: 'document',
          });
          resolveFirstClassification = resolve;
        }),
    )
    .mockImplementationOnce((_error, ctx) => {
      expect(ctx).toMatchObject({
        phase: 'fetch',
        sessionKey,
        storeType: 'document',
      });
      return Promise.resolve('ignore' as const);
    });

  const createOfflineEnv = (storeName: string) =>
    createDocumentStoreTestEnv(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offlineMode: {
          outage: { enabled: true, classifyFailure, recoveryCheck },
          operations: {},
        },
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
  expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
    effectiveOffline: false,
    effectiveMode: 'online',
    outage: { active: false },
    lastRecoveryCheckAt: null,
  });
  expect(staleClassificationEnv.store.state.error?.id ?? null).not.toBe(
    'offline',
  );
  expect(newerFailureEnv.store.state.error?.id ?? null).not.toBe('offline');

  // Resolving the stale classifier must not retroactively flip either store into outage mode.
  resolveFirstClassification?.('outage');
  await Promise.resolve();
  await Promise.resolve();

  expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
    effectiveOffline: false,
    effectiveMode: 'online',
    outage: { active: false },
  });
  expect(staleClassificationEnv.store.state.error?.id ?? null).not.toBe(
    'offline',
  );
  expect(newerFailureEnv.store.state.error?.id ?? null).not.toBe('offline');
});
