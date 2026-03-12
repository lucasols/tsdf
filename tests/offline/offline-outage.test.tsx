import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getGlobalOfflineStatus, localPersistentStorage } from '../../src/main';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { docSchema } from './offlineTestShared';

describe('offline mode outage and recovery', () => {
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
    const env = createDocumentStoreTestEnv(1, {
      getSessionKey: () => sessionKey,
      persistentStorage: {
        storeName: 'outage-doc',
        adapter: localPersistentStorage,
        schema: docSchema,
        offlineMode: {
          outage: {
            enabled: true,
            classifyFailure: async () => {
              await Promise.resolve();
              return 'outage' as const;
            },
            recoveryCheck: () => true,
          },
          operations: {},
        },
      },
    });

    env.serverMock.setNextFetchError('boom');
    env.apiStore.scheduleFetch('highPriority');
    await advanceTime(25);

    expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
      effectiveMode: 'offline',
      effectiveOffline: true,
      network: { active: false, enabled: false },
      outage: { active: true, enabled: true },
      sessionKey: 'outage-session',
    });
    expect(env.store.state.error).toEqual({
      code: 0,
      id: 'offline',
      message: 'Offline',
    });
  });

  test('recovery probes back off and stop after a successful recovery check', async () => {
    const sessionKey = 'recovery-probe-session';
    const recoveryCheck = vi
      .fn<({ sessionKey }: { sessionKey: string }) => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    const env = createDocumentStoreTestEnv(1, {
      getSessionKey: () => sessionKey,
      persistentStorage: {
        storeName: 'recovery-probe-doc',
        adapter: localPersistentStorage,
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

    env.serverMock.setNextFetchError('boom');
    env.apiStore.scheduleFetch('highPriority');
    await advanceTime(25);

    expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
      effectiveOffline: true,
      outage: { active: true, enabled: true },
    });
    expect(recoveryCheck).toHaveBeenCalledTimes(0);

    await advanceTime(100);
    expect(recoveryCheck).toHaveBeenCalledTimes(1);

    await advanceTime(200);
    expect(recoveryCheck).toHaveBeenCalledTimes(2);
    expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
      effectiveOffline: false,
      effectiveMode: 'online',
      outage: { active: false, enabled: true },
    });
  });

  test('stale async outage classifications are ignored after a newer failure settles first', async () => {
    const sessionKey = 'stale-outage-session';
    let resolveFirstClassification:
      | ((result: 'outage' | 'ignore') => void)
      | undefined;
    const recoveryCheck = () => false;

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
        () =>
          new Promise<'outage' | 'ignore'>((resolve) => {
            resolveFirstClassification = resolve;
          }),
      )
      .mockResolvedValueOnce('ignore');

    const createOfflineEnv = (storeName: string) =>
      createDocumentStoreTestEnv(1, {
        getSessionKey: () => sessionKey,
        persistentStorage: {
          storeName,
          adapter: localPersistentStorage,
          schema: docSchema,
          offlineMode: {
            outage: { enabled: true, classifyFailure, recoveryCheck },
            operations: {},
          },
        },
      });

    const firstEnv = createOfflineEnv('stale-outage-doc-1');
    const secondEnv = createOfflineEnv('stale-outage-doc-2');

    firstEnv.serverMock.setNextFetchError('first failure');
    firstEnv.apiStore.scheduleFetch('highPriority');
    await advanceTime(25);
    await Promise.resolve();

    secondEnv.serverMock.setNextFetchError('second failure');
    secondEnv.apiStore.scheduleFetch('highPriority');
    await advanceTime(25);
    await Promise.resolve();

    resolveFirstClassification?.('outage');
    await Promise.resolve();
    await Promise.resolve();

    expect(classifyFailure).toHaveBeenCalledTimes(2);
    expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
      effectiveOffline: false,
      effectiveMode: 'online',
      outage: { active: false },
    });
    expect(firstEnv.store.state.error?.id ?? null).not.toBe('offline');
    expect(secondEnv.store.state.error?.id ?? null).not.toBe('offline');
  });
});
