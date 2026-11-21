import { sleep } from '@ls-stack/utils/sleep';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { rc_string } from 'runcheck';
import { vi } from 'vitest';
import type {
  OfflineHealthCheckContext,
  OfflineHealthCheckResult,
  OfflineSessionConfig,
} from '../../src/main';
import { useGlobalOfflineStatus } from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { userRowSchema } from './offlineReplayTestShared';
import { listQueryQueryPayloadSchema } from './offlineTestShared';

/** How long the mocked health endpoint takes to answer. */
export const HEALTH_CHECK_DURATION_MS = 100;

/** Recovery cadence used by the health check tests: one check per second. */
export const healthRecoveryProbe = {
  initialIntervalMs: 1_000,
  maxIntervalMs: 1_000,
  backoffMultiplier: 1,
  jitterRatio: 0,
} as const;

/**
 * Mock of the app's health endpoint, wired as
 * `offlineSession.healthCheck.check`. Every request takes
 * `HEALTH_CHECK_DURATION_MS` and answers with the state the backend is in when
 * the request settles (see `setBackend`).
 */
export function createHealthCheckMock() {
  let backend: OfflineHealthCheckResult = 'up';

  const check = vi.fn<
    (ctx: OfflineHealthCheckContext) => Promise<OfflineHealthCheckResult>
  >(async () => {
    await sleep(HEALTH_CHECK_DURATION_MS);
    return backend;
  });

  return {
    check,
    /** What the health endpoint answers from now on. */
    setBackend(next: OfflineHealthCheckResult) {
      backend = next;
    },
  };
}

/**
 * Renders the session offline status like an app would and logs it, together
 * with the number of health requests made so far, every time the session
 * changes mode or finishes a recovery check. A test can then snapshot one
 * readable timeline of the session.
 */
export function trackOfflineSession(
  sessionKey: string,
  health: { check: { mock: { calls: unknown[] } } },
) {
  const log = createLoggerStore();
  let lastLogged = '';

  const hook = renderHook(() => {
    const { network, outage, lastRecoveryCheckAt } =
      useGlobalOfflineStatus(sessionKey);
    const activeModes = [
      ...(network.active ? ['network'] : []),
      ...(outage.active ? ['outage'] : []),
    ];
    const session =
      activeModes.length > 0
        ? `offline (${activeModes.join(' + ')})`
        : 'online';

    // The status object also changes for bookkeeping (`updatedAt`): those
    // renders say nothing new about the session.
    const logged = `${session}|${lastRecoveryCheckAt}`;
    if (logged === lastLogged) return;
    lastLogged = logged;

    log.add({
      at: `${Date.now() - TEST_INITIAL_TIME}ms`,
      session,
      healthChecks: health.check.mock.calls.length,
    });
  });

  return { log, unmount: () => hook.unmount() };
}

/** A users list store attached to a session with the given offline config. */
export function createOfflineUsersEnv(
  sessionKey: string,
  offlineSession: OfflineSessionConfig,
) {
  return createListQueryStoreTestEnv(
    {
      users: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
        { id: 3, name: 'Linus' },
      ],
    },
    {
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession,
      }),
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
