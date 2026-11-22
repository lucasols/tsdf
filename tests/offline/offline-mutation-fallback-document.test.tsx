import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OfflineFailureContext } from '../../src/main';
import { getGlobalOfflineStatus } from '../../src/persistentStorage/offline/sessionCoordinator';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import {
  getOfflineQueueEntries,
  type UpdateValueOperations,
} from './offlineReplayTestShared';
import { getSingleQueuedMutationData } from './offlineReplayTestShared';
import {
  classifyMutationOutage,
  docMutationInputSchema,
  docSchema,
  quickRecoveryProbe,
  waitForMicrotaskCondition,
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

describe('document', () => {
  test('disallowed browser-offline network mode still runs the direct mutation and preserves its error', async () => {
    network.setOffline();
    const sessionKey = 'hybrid-doc-network-disallowed-offline-session';
    const storeName = 'hybrid-doc-network-disallowed-offline-store';
    const directMutation = vi.fn(() =>
      navigator.onLine
        ? env.serverMock.delayedSetData(2).then(() => 2)
        : Promise.reject(new Error('browser-offline-direct-error')),
    );
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
          network: network.config,
          mutationQueueing: { network: 'disallow' },
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
              execute: async ({ input }) => {
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

    const result = await env.apiStore.performMutation({
      mutation: directMutation,
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    expect({ error: result.ok ? null : result.error, ok: result.ok })
      .toMatchInlineSnapshot(`
        error{Error}:
          message: 'browser-offline-direct-error'
          name: 'StoreMutationError'
          kind: 'error'
          code: 500
          id: 'fetch-error'
          cause:
            Error#: { message: 'browser-offline-direct-error', name: 'Error' }

        ok: '❌'
      `);
    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
  });

  test('when browser-offline network mode is already active, queue immediately without calling the direct mutation', async () => {
    network.setOffline();
    const sessionKey = 'hybrid-doc-offline-session';
    const storeName = 'hybrid-doc-offline-store';
    const directMutation = vi.fn(() =>
      env.serverMock.delayedSetData(2).then(() => 2),
    );
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
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
              execute: async ({ input }) => {
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

    // The browser is already offline, so we should persist the queue entry
    // without ever invoking the direct mutation callback.
    const result = await env.apiStore.performMutation({
      mutation: directMutation,
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    expect({ ok: result.ok, value: result.ok ? result.value : null })
      .toMatchInlineSnapshot(`
        ok: '✅'
        value: { kind: 'queued' }
      `);
    expect(directMutation).not.toHaveBeenCalled();
    expect(getSingleQueuedMutationData(sessionKey, storeName))
      .toMatchInlineSnapshot(`
        input: { value: 2 }
        operation: 'updateValue'
      `);
  });

  test('call the direct mutation while online and skip queueing on success', async () => {
    const sessionKey = 'hybrid-doc-online-session';
    const storeName = 'hybrid-doc-online-store';
    const directMutation = vi.fn(() =>
      env.serverMock.delayedSetData(2).then(() => 2),
    );
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
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
              execute: async ({ input }) => {
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

    // Online offline-enabled mutations should behave like normal direct
    // mutations until a failure is classified as connectivity-related.
    const pendingResult = env.apiStore.performMutation({
      mutation: directMutation,
      offline: { operation: 'updateValue', input: { value: 2 } },
    });
    await flushAllTimers();
    const result = await pendingResult;

    expect({ ok: result.ok, value: result.ok ? result.value : null })
      .toMatchInlineSnapshot(`
        ok: '✅'
        value: { data: 2, kind: 'online' }
      `);
    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
  });

  test('fallback to queueing when the direct failure is classified as offline', async () => {
    const sessionKey = 'hybrid-doc-fallback-session';
    const storeName = 'hybrid-doc-fallback-store';
    const directMutation = vi.fn(() =>
      Promise.reject(new Error('offline-fallback')),
    );
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
          network: network.config,
          classifyFailure: (error, ctx) =>
            classifyMutationOutage(error, ctx.phase) ? 'outage' : 'ignore',
          outage: {
            enabled: true,
            recoveryCheck: () => false,
            recoveryProbe: quickRecoveryProbe,
          },
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
              execute: async ({ input }) => {
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

    // Direct failures that the session classifies as outage/offline should
    // become a durable queued success instead of surfacing an error.
    const result = await env.apiStore.performMutation({
      mutation: directMutation,
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    expect({ ok: result.ok, value: result.ok ? result.value : null })
      .toMatchInlineSnapshot(`
        ok: '✅'
        value: { kind: 'queued' }
      `);
    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(getSingleQueuedMutationData(sessionKey, storeName))
      .toMatchInlineSnapshot(`
        input: { value: 2 }
        operation: 'updateValue'
      `);

    expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
      isForcedOffline: '❌'
      isLeader: '✅'
      isNetworkDetectedOffline: '❌'
      isOfflineMode: '✅'
      lastFailureAt: 1735689600000
      lastRecoveryCheckAt: null
      network: { active: '❌', enabled: '✅' }
      outage: { active: '✅', enabled: '✅' }
      sessionKey: 'hybrid-doc-fallback-session'
      updatedAt: 1735689600000
    `);
  });

  test('when error-classified network mode is already active, queue immediately without calling the direct mutation', async () => {
    const sessionKey = 'hybrid-doc-network-active-session';
    const storeName = 'hybrid-doc-network-active-store';
    const directMutation = vi.fn(() =>
      env.serverMock.delayedSetData(2).then(() => 2),
    );
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
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
              execute: async ({ input }) => {
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

    // Activate network offline mode through a fetch failure so the mutation
    // under test proves the already-offline branch skips the direct callback.
    env.serverMock.setNextFetchError('boom');
    env.apiStore.scheduleFetch('highPriority');
    await advanceTime(25);

    expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
      isForcedOffline: '❌'
      isLeader: '✅'
      isNetworkDetectedOffline: '❌'
      isOfflineMode: '✅'
      lastFailureAt: 1735689600010
      lastRecoveryCheckAt: null
      network: { active: '✅', enabled: '✅' }
      outage: { active: '❌', enabled: '❌' }
      sessionKey: 'hybrid-doc-network-active-session'
      updatedAt: 1735689600010
    `);

    const result = await env.apiStore.performMutation({
      mutation: directMutation,
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    expect({ ok: result.ok, value: result.ok ? result.value : null })
      .toMatchInlineSnapshot(`
        ok: '✅'
        value: { kind: 'queued' }
      `);
    expect(directMutation).not.toHaveBeenCalled();
    expect(getSingleQueuedMutationData(sessionKey, storeName))
      .toMatchInlineSnapshot(`
        input: { value: 2 }
        operation: 'updateValue'
      `);

    expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
      isForcedOffline: '❌'
      isLeader: '✅'
      isNetworkDetectedOffline: '❌'
      isOfflineMode: '✅'
      lastFailureAt: 1735689600010
      lastRecoveryCheckAt: null
      network: { active: '✅', enabled: '✅' }
      outage: { active: '❌', enabled: '❌' }
      sessionKey: 'hybrid-doc-network-active-session'
      updatedAt: 1735689600010
    `);
  });

  test('when outage mode is already active, queue immediately without calling the direct mutation', async () => {
    const sessionKey = 'hybrid-doc-outage-active-session';
    const storeName = 'hybrid-doc-outage-active-store';
    const directMutation = vi.fn(() =>
      env.serverMock.delayedSetData(2).then(() => 2),
    );
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
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
              execute: async ({ input }) => {
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

    // Activate outage mode through a fetch failure so the mutation under test
    // proves the already-outage branch skips the direct callback.
    env.serverMock.setNextFetchError('boom');
    env.apiStore.scheduleFetch('highPriority');
    await advanceTime(25);

    expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
      isForcedOffline: '❌'
      isLeader: '✅'
      isNetworkDetectedOffline: '❌'
      isOfflineMode: '✅'
      lastFailureAt: 1735689600010
      lastRecoveryCheckAt: null
      network: { active: '❌', enabled: '❌' }
      outage: { active: '✅', enabled: '✅' }
      sessionKey: 'hybrid-doc-outage-active-session'
      updatedAt: 1735689600010
    `);

    const result = await env.apiStore.performMutation({
      mutation: directMutation,
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    expect({ ok: result.ok, value: result.ok ? result.value : null })
      .toMatchInlineSnapshot(`
        ok: '✅'
        value: { kind: 'queued' }
      `);
    expect(directMutation).not.toHaveBeenCalled();
    expect(getSingleQueuedMutationData(sessionKey, storeName))
      .toMatchInlineSnapshot(`
        input: { value: 2 }
        operation: 'updateValue'
      `);

    expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
      isForcedOffline: '❌'
      isLeader: '✅'
      isNetworkDetectedOffline: '❌'
      isOfflineMode: '✅'
      lastFailureAt: 1735689600010
      lastRecoveryCheckAt: null
      network: { active: '❌', enabled: '❌' }
      outage: { active: '✅', enabled: '✅' }
      sessionKey: 'hybrid-doc-outage-active-session'
      updatedAt: 1735689600010
    `);
  });

  test('disallowed classified network mode still retries the direct mutation while the browser is online', async () => {
    const sessionKey = 'hybrid-doc-network-disallowed-online-session';
    const storeName = 'hybrid-doc-network-disallowed-online-store';
    const directMutation = vi.fn(() =>
      env.serverMock.delayedSetData(2).then(() => 2),
    );
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
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
          mutationQueueing: { network: 'disallow' },
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
              execute: async ({ input }) => {
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

    env.serverMock.setNextFetchError('boom');
    env.apiStore.scheduleFetch('highPriority');
    await advanceTime(25);

    const result = await resolveAfterAllTimers(
      env.apiStore.performMutation({
        mutation: directMutation,
        offline: { operation: 'updateValue', input: { value: 2 } },
      }),
    );

    expect({ ok: result.ok, value: result.ok ? result.value : null })
      .toMatchInlineSnapshot(`
        ok: '✅'
        value: { data: 2, kind: 'online' }
      `);
    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
    expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
      isForcedOffline: '❌'
      isLeader: '✅'
      isNetworkDetectedOffline: '❌'
      isOfflineMode: '❌'
      lastFailureAt: 1735689600010
      lastRecoveryCheckAt: 1735689601210
      network: { active: '❌', enabled: '✅' }
      outage: { active: '❌', enabled: '❌' }
      sessionKey: 'hybrid-doc-network-disallowed-online-session'
      updatedAt: 1735689601225
    `);
  });

  test('disallowed classified network fallback preserves the original direct error instead of queueing', async () => {
    const sessionKey = 'hybrid-doc-network-disallowed-fallback-session';
    const storeName = 'hybrid-doc-network-disallowed-fallback-store';
    const directMutation = vi.fn(() =>
      Promise.reject(new Error('network-disallowed-error')),
    );
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
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
          mutationQueueing: { network: 'disallow' },
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
              execute: async ({ input }) => {
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

    const result = await env.apiStore.performMutation({
      mutation: directMutation,
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    expect({ error: result.ok ? null : result.error, ok: result.ok })
      .toMatchInlineSnapshot(`
        error{Error}:
          message: 'network-disallowed-error'
          name: 'StoreMutationError'
          kind: 'error'
          code: 500
          id: 'fetch-error'
          cause:
            Error#: { message: 'network-disallowed-error', name: 'Error' }

        ok: '❌'
      `);
    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
  });

  test('disallowed outage mode still retries the direct mutation before deciding not to queue', async () => {
    const sessionKey = 'hybrid-doc-outage-disallowed-online-session';
    const storeName = 'hybrid-doc-outage-disallowed-online-store';
    const directMutation = vi.fn(() =>
      env.serverMock.delayedSetData(2).then(() => 2),
    );
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
          classifyFailure: () => 'outage' as const,
          outage: {
            enabled: true,
            recoveryCheck: () => false,
            recoveryProbe: quickRecoveryProbe,
          },
          mutationQueueing: { outage: 'disallow' },
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
              execute: async ({ input }) => {
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

    env.serverMock.setNextFetchError('boom');
    env.apiStore.scheduleFetch('highPriority');
    await advanceTime(25);

    const pendingResult = env.apiStore.performMutation({
      mutation: directMutation,
      offline: { operation: 'updateValue', input: { value: 2 } },
    });
    await flushAllTimers();
    const result = await pendingResult;

    expect({ ok: result.ok, value: result.ok ? result.value : null })
      .toMatchInlineSnapshot(`
        ok: '✅'
        value: { data: 2, kind: 'online' }
      `);
    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
    expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
      isForcedOffline: '❌'
      isLeader: '✅'
      isNetworkDetectedOffline: '❌'
      isOfflineMode: '❌'
      lastFailureAt: 1735689600010
      lastRecoveryCheckAt: 1735689601224
      network: { active: '❌', enabled: '❌' }
      outage: { active: '❌', enabled: '✅' }
      sessionKey: 'hybrid-doc-outage-disallowed-online-session'
      updatedAt: 1735689601225
    `);
  });

  test('disallowed outage fallback preserves the original direct error instead of queueing', async () => {
    const sessionKey = 'hybrid-doc-outage-disallowed-fallback-session';
    const storeName = 'hybrid-doc-outage-disallowed-fallback-store';
    const directMutation = vi.fn(() =>
      Promise.reject(new Error('outage-disallowed-error')),
    );
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
          classifyFailure: () => 'outage' as const,
          outage: {
            enabled: true,
            recoveryCheck: () => false,
            recoveryProbe: quickRecoveryProbe,
          },
          mutationQueueing: { outage: 'disallow' },
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
              execute: async ({ input }) => {
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

    const result = await env.apiStore.performMutation({
      mutation: directMutation,
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    expect({ error: result.ok ? null : result.error, ok: result.ok })
      .toMatchInlineSnapshot(`
        error{Error}:
          message: 'outage-disallowed-error'
          name: 'StoreMutationError'
          kind: 'error'
          code: 500
          id: 'fetch-error'
          cause:
            Error#: { message: 'outage-disallowed-error', name: 'Error' }

        ok: '❌'
      `);
    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
  });

  test('mixed queueing policy can still queue outage-classified failures while network queueing stays disabled', async () => {
    const sessionKey = 'hybrid-doc-mixed-queue-policy-session';
    const storeName = 'hybrid-doc-mixed-queue-policy-store';
    const directMutation = vi.fn(() =>
      Promise.reject(new Error('offline-fallback')),
    );
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
          network: network.config,
          classifyFailure: (error, ctx) =>
            classifyMutationOutage(error, ctx.phase) ? 'outage' : 'ignore',
          outage: {
            enabled: true,
            recoveryCheck: () => false,
            recoveryProbe: quickRecoveryProbe,
          },
          mutationQueueing: { network: 'disallow', outage: 'allow' },
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
              execute: async ({ input }) => {
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

    const result = await env.apiStore.performMutation({
      mutation: directMutation,
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    expect({ ok: result.ok, value: result.ok ? result.value : null })
      .toMatchInlineSnapshot(`
        ok: '✅'
        value: { kind: 'queued' }
      `);
    expect(getSingleQueuedMutationData(sessionKey, storeName))
      .toMatchInlineSnapshot(`
        input: { value: 2 }
        operation: 'updateValue'
      `);
  });

  test('stale async mutation classifications do not queue after a newer failure settles first', async () => {
    const sessionKey = 'hybrid-doc-stale-mutation-classification-session';
    const storeNameA = 'hybrid-doc-stale-mutation-classification-store-a';
    const storeNameB = 'hybrid-doc-stale-mutation-classification-store-b';
    let resolveFirstClassification:
      | ((result: 'outage' | 'network' | 'ignore') => void)
      | undefined;
    const recoveryCheck = vi.fn(() => false);
    const classifyFailure = vi
      .fn<
        (
          error: unknown,
          ctx: OfflineFailureContext,
        ) => Promise<'outage' | 'network' | 'ignore'>
      >()
      .mockImplementationOnce(
        () =>
          new Promise<'outage' | 'network' | 'ignore'>((resolve) => {
            resolveFirstClassification = resolve;
          }),
      )
      .mockResolvedValueOnce('ignore');
    const createEnv = (id: string) => {
      const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
        id,
        getSessionKey: () => sessionKey,
        storeManager: createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey: () => sessionKey,
          offlineSession: {
            classifyFailure,
            outage: {
              enabled: true,
              recoveryCheck,
              recoveryProbe: quickRecoveryProbe,
            },
            mutationQueueing: { outage: 'allow' },
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
                execute: async ({ input }) => {
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
    };

    const envA = createEnv(storeNameA);
    const envB = createEnv(storeNameB);

    // Start one mutation whose failure classification stays pending so a newer
    // failure can settle the session state first.
    const pendingMutation = envA.apiStore.performMutation({
      mutation: () => Promise.reject(new Error('first failure')),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    await Promise.resolve();

    // The later failure resolves immediately as a normal error, so any stale
    // result from the first classification must be ignored afterwards.
    const settledMutation = await envB.apiStore.performMutation({
      mutation: () => Promise.reject(new Error('second failure')),
      offline: { operation: 'updateValue', input: { value: 3 } },
    });

    expect({
      error: settledMutation.ok ? null : settledMutation.error,
      ok: settledMutation.ok,
    }).toMatchInlineSnapshot(`
      error{Error}:
        message: 'second failure'
        name: 'StoreMutationError'
        kind: 'error'
        code: 500
        id: 'fetch-error'
        cause:
          Error#: { message: 'second failure', name: 'Error' }

      ok: '❌'
    `);

    // Resolving the older classification as an outage must not retroactively
    // queue the earlier mutation or flip the session into offline mode.
    resolveFirstClassification?.('outage');
    const result = await pendingMutation;

    expect({ error: result.ok ? null : result.error, ok: result.ok })
      .toMatchInlineSnapshot(`
        error{Error}:
          message: 'first failure'
          name: 'StoreMutationError'
          kind: 'error'
          code: 500
          id: 'fetch-error'
          cause:
            Error#: { message: 'first failure', name: 'Error' }

        ok: '❌'
      `);
    expect(classifyFailure).toHaveBeenCalledTimes(2);
    expect(
      getOfflineQueueEntries(sessionKey, storeNameA).concat(
        getOfflineQueueEntries(sessionKey, storeNameB),
      ),
    ).toMatchInlineSnapshot(`[]`);
    expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
      isForcedOffline: '❌'
      isLeader: '✅'
      isNetworkDetectedOffline: '❌'
      isOfflineMode: '❌'
      lastFailureAt: null
      lastRecoveryCheckAt: null
      network: { active: '❌', enabled: '❌' }
      outage: { active: '❌', enabled: '❌' }
      sessionKey: 'hybrid-doc-stale-mutation-classification-session'
      updatedAt: 1735689600000
    `);
  });

  test('preserve the normal error when the direct failure is not connectivity-related', async () => {
    const sessionKey = 'hybrid-doc-error-session';
    const storeName = 'hybrid-doc-error-store';
    const directMutation = vi.fn(() =>
      Promise.reject(new Error('validation-error')),
    );
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
          network: network.config,
          classifyFailure: (error, ctx) =>
            classifyMutationOutage(error, ctx.phase) ? 'outage' : 'ignore',
          outage: {
            enabled: true,
            recoveryCheck: () => false,
            recoveryProbe: quickRecoveryProbe,
          },
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
              execute: async ({ input }) => {
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

    const result = await env.apiStore.performMutation({
      mutation: directMutation,
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    expect(result.ok).toBe(false);
    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
  });

  test('online direct mutations that return undefined still revalidate', async () => {
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      getSessionKey: () => 'hybrid-doc-void-online-session',
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => 'hybrid-doc-void-online-session',
        offlineSession: { network: network.config },
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
              execute: async ({ input }) => {
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
    const documentHook = renderHook(() =>
      env.apiStore.useDocument({
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      }),
    );

    env.serverMock.setData(2);

    const result = await resolveAfterAllTimers(
      env.apiStore.performMutation({
        mutation: async () => {
          await env.serverMock.delayedSetData(2);
        },
        revalidateOnSuccess: true,
        offline: { operation: 'updateValue', input: { value: 2 } },
      }),
    );

    expect({ ok: result.ok, value: result.ok ? result.value : null })
      .toMatchInlineSnapshot(`
        ok: '✅'
        value: { kind: 'online' }
      `);

    await advanceTime(1_200);
    await waitForMicrotaskCondition(
      () => documentHook.result.current.data?.value === 2,
    );

    expect(documentHook.result.current.data).toMatchInlineSnapshot(`value: 2`);
    documentHook.unmount();
  });
});
