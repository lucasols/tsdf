import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import {
  collectionCreateInputSchema,
  collectionSchema,
  docMutationInputSchema,
  docSchema,
} from './offlineTestShared';
import {
  type CreateUserOperations,
  getLocalStorageKeys,
  getOfflineQueueEntries,
  getOfflineQueueEntryData,
  type UpdateValueOperations,
} from './offlineReplayTestShared';

async function waitForMicrotaskCondition(
  condition: () => boolean,
  maxTurns = 20,
): Promise<void> {
  for (let turn = 0; turn < maxTurns && !condition(); turn += 1) {
    await Promise.resolve();
  }
}

describe('offline replay queueing and retry behavior', () => {
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

  test('collection offline creates keep durable temp-id metadata and clear after replay finishes', async () => {
    network.setOffline();
    const resolveCreates: Array<
      (result: { id: string; name: string }) => void
    > = [];

    const env = createCollectionStoreTestEnv<
      { name: string },
      CreateUserOperations
    >(
      { 'users||1': { name: 'User 1' } },
      {
        getSessionKey: () => 'offline-temp-id-session',
        testScenario: 'loaded',
        persistentStorage: {
          storeName: 'offline-temp-id-collection',
          adapter: 'local-sync',
          schema: collectionSchema,
          payloadSchema: rc_string,
          offlineMode: {
            network: network.config,
            operations: {
              createUser: {
                inputSchema: collectionCreateInputSchema,
                getEntityRefs: ({ input }) => [`temp:${input.name}`],
                accumulation: {
                  mergeInput: ({ incomingInput }) => incomingInput,
                },
                tempEntity: {
                  createTempId: (input) => `temp:${input.name}`,
                  buildPendingEntity: (input) => ({
                    value: { name: input.name },
                  }),
                  reconcileServerEntity: (result) => ({
                    finalPayload: result.id,
                    finalData: { value: { name: result.name } },
                  }),
                },
                execute: () =>
                  new Promise<{ id: string; name: string }>((resolve) => {
                    resolveCreates.push(resolve);
                  }),
              },
            },
          },
        },
      },
    );

    await Promise.resolve();
    act(() => {
      network.goOffline();
    });
    await Promise.resolve();

    const queued = await env.apiStore.performMutation('__create__', {
      mutation: () => Promise.resolve({ value: { name: 'Ada' } }),
      offline: { operation: 'createUser', input: { name: 'Ada' } },
    });
    await env.apiStore.performMutation('__create__', {
      mutation: () => Promise.resolve({ value: { name: 'Ada' } }),
      offline: { operation: 'createUser', input: { name: 'Ada' } },
    });

    expect(queued.ok).toBe(true);
    expect(env.apiStore.getOfflineEntities()).toMatchObject([
      { entityKey: 'temp:Ada', pendingMutations: 2, tempId: 'temp:Ada' },
    ]);

    act(() => {
      network.goOnline();
    });
    await waitForMicrotaskCondition(() => resolveCreates.length > 0);
    expect(resolveCreates).toHaveLength(1);
    resolveCreates[0]?.({ id: 'users||ada', name: 'Ada' });
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(resolveCreates).toHaveLength(2);
    resolveCreates[1]?.({ id: 'users||ada-2', name: 'Ada' });
    await flushAllTimers();

    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  });

  test('document offline accumulation keeps a single persisted queue entry and replays only the merged input', async () => {
    network.setOffline();
    const sessionKey = 'offline-accumulation-session';
    const storeName = 'offline-accumulation-doc';
    const execute = vi
      .fn<
        ({
          input,
          enqueuedAt,
        }: {
          input: { value: number };
          enqueuedAt: number;
        }) => { value: number }
      >()
      .mockImplementation(({ input, enqueuedAt }) => {
        expect(enqueuedAt).toBe(TEST_INITIAL_TIME);
        env.apiStore.updateState((draft) => {
          draft.value = input.value;
        });

        return input;
      });

    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        storeName,
        adapter: 'local-sync',
        schema: docSchema,
        offlineMode: {
          network: network.config,
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              accumulation: {
                mergeInput: ({ incomingInput }) => incomingInput,
              },
              execute,
            },
          },
        },
      },
    });

    await env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: () => Promise.resolve(2),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    await advanceTime(50);
    await env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 3;
        });
      },
      mutation: () => Promise.resolve(3),
      offline: { operation: 'updateValue', input: { value: 3 } },
    });

    expect(env.store.state.data).toMatchInlineSnapshot(`
      value: 3
    `);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
      - createdAt: 1735689600000
        entityKey: 'document'
        entityKind: 'document'
        hasConflict: '❌'
        id: 'offline-accumulation-session:offline-accumulation-doc:document'
        pendingMutations: 1
        sessionKey: 'offline-accumulation-session'
        storeName: 'offline-accumulation-doc'
        storeType: 'document'
        syncState: 'pending'
        updatedAt: 1735689600050
    `);
    expect(
      getOfflineQueueEntries(sessionKey, storeName).map((entry) => {
        const data = getOfflineQueueEntryData(entry);

        return {
          timestamp: entry.timestamp,
          version: entry.version,
          data: {
            attempts: data.attempts,
            createdAt: data.createdAt,
            entityRefs: data.entityRefs,
            input: data.input,
            lastAttemptAt: data.lastAttemptAt,
            operation: data.operation,
            sessionKey: data.sessionKey,
            storeName: data.storeName,
            storeType: data.storeType,
            syncState: data.syncState,
            updatedAt: data.updatedAt,
          },
        };
      }),
    ).toMatchInlineSnapshot(`
      - data:
          attempts: 0
          createdAt: 1735689600000
          entityRefs:
            - { entityKey: 'document', entityKind: 'document' }
          input: { value: 3 }
          lastAttemptAt: null
          operation: 'updateValue'
          sessionKey: 'offline-accumulation-session'
          storeName: 'offline-accumulation-doc'
          storeType: 'document'
          syncState: 'pending'
          updatedAt: 1735689600050
        timestamp: 1735689600050
    `);

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    expect(execute.mock.calls.map(([ctx]) => ctx.input)).toMatchInlineSnapshot(`
      - value: 3
    `);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
  });

  test('needs-confirmation entries are skipped when shouldSkipSync returns true', async () => {
    network.setOffline();
    let skipCheckEnqueuedAt: number | null = null;

    const execute = vi
      .fn<
        ({
          input,
          enqueuedAt,
        }: {
          input: { value: number };
          enqueuedAt: number;
        }) => Promise<{ value: number }>
      >()
      .mockImplementationOnce(({ input, enqueuedAt }) => {
        expect(enqueuedAt).toBe(TEST_INITIAL_TIME);
        throw new Error(`dispatch failed after send ${input.value}`);
      });
    const shouldSkipSync = vi
      .fn<
        ({
          input,
          enqueuedAt,
        }: {
          input: { value: number };
          enqueuedAt: number;
        }) => Promise<boolean>
      >()
      .mockImplementation(({ input, enqueuedAt }) => {
        skipCheckEnqueuedAt = enqueuedAt;
        expect(input.value).toBe(2);
        return Promise.resolve(true);
      });
    const recoveryCheck = vi
      .fn<({ sessionKey }: { sessionKey: string }) => boolean>()
      .mockReturnValue(true);

    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      getSessionKey: () => 'needs-confirmation-session',
      testScenario: 'loaded',
      persistentStorage: {
        storeName: 'needs-confirmation-doc',
        adapter: 'local-sync',
        schema: docSchema,
        offlineMode: {
          network: { enabled: true },
          outage: {
            enabled: true,
            classifyFailure: (_error, ctx) =>
              ctx.phase === 'sync' ? 'outage' : 'ignore',
            recoveryCheck,
            recoveryProbe: {
              intervalMs: 50,
              maxIntervalMs: 50,
              backoffMultiplier: 1,
              jitterRatio: 0,
            },
          },
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute,
              shouldSkipSync,
            },
          },
        },
      },
    });

    await env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: () => Promise.resolve(2),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    act(() => {
      network.goOnline();
    });
    await advanceTime(60);
    await flushAllTimers();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(shouldSkipSync).toHaveBeenCalledTimes(1);
    expect(skipCheckEnqueuedAt).toBe(TEST_INITIAL_TIME);
    expect(recoveryCheck).toHaveBeenCalledTimes(1);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  });

  test('needs-confirmation entries retry execute when shouldSkipSync returns false', async () => {
    let skipCheckEnqueuedAt: number | null = null;
    const execute = vi
      .fn<
        ({
          input,
          enqueuedAt,
        }: {
          input: { value: number };
          enqueuedAt: number;
        }) => Promise<{ value: number }>
      >()
      .mockImplementationOnce(({ input, enqueuedAt }) => {
        expect(enqueuedAt).toBe(TEST_INITIAL_TIME);
        throw new Error(`dispatch failed after send ${input.value}`);
      })
      .mockResolvedValue({ value: 2 });
    const shouldSkipSync = vi
      .fn<
        ({
          input,
          enqueuedAt,
        }: {
          input: { value: number };
          enqueuedAt: number;
        }) => Promise<boolean>
      >()
      .mockImplementation(({ input, enqueuedAt }) => {
        skipCheckEnqueuedAt = enqueuedAt;
        expect(input.value).toBe(2);
        return Promise.resolve(false);
      });

    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      getSessionKey: () => 'needs-confirmation-no-outage-session',
      testScenario: 'loaded',
      persistentStorage: {
        storeName: 'needs-confirmation-no-outage-doc',
        adapter: 'local-sync',
        schema: docSchema,
        offlineMode: {
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute,
              shouldSkipSync,
            },
          },
        },
      },
    });

    const mutationResult = await env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: () => Promise.resolve(2),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    expect(mutationResult.ok).toBe(true);

    await Promise.resolve();
    await Promise.resolve();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(shouldSkipSync).toHaveBeenCalledTimes(0);

    await advanceTime(300);
    await flushAllTimers();

    expect(shouldSkipSync).toHaveBeenCalledTimes(1);
    expect(skipCheckEnqueuedAt).toBe(TEST_INITIAL_TIME);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  });

  test('needs-confirmation entries do not accept new accumulation before shouldSkipSync runs', async () => {
    network.setOffline();
    const execute = vi
      .fn<
        ({ input }: { input: { value: number } }) => Promise<{ value: number }>
      >()
      .mockRejectedValueOnce(new Error('dispatch failed after send'))
      .mockResolvedValue({ value: 3 });

    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      getSessionKey: () => 'offline-needs-confirmation-accumulation-session',
      testScenario: 'loaded',
      persistentStorage: {
        storeName: 'offline-needs-confirmation-accumulation-doc',
        adapter: 'local-sync',
        schema: docSchema,
        offlineMode: {
          network: { enabled: true },
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              accumulation: {
                mergeInput: ({ incomingInput }) => incomingInput,
              },
              execute,
              shouldSkipSync: () => false,
            },
          },
        },
      },
    });
    await Promise.resolve();

    await env.apiStore.performMutation({
      mutation: () => Promise.resolve(2),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    act(() => {
      network.goOnline();
    });
    await advanceTime(1);
    await Promise.resolve();

    expect(env.apiStore.getOfflineEntities()).toMatchObject([
      {
        entityKey: 'document',
        pendingMutations: 1,
        syncState: 'needs-confirmation',
      },
    ]);

    act(() => {
      network.goOffline();
    });
    await Promise.resolve();

    await env.apiStore.performMutation({
      mutation: () => Promise.resolve(3),
      offline: { operation: 'updateValue', input: { value: 3 } },
    });

    expect(env.apiStore.getOfflineEntities()).toMatchObject([
      { entityKey: 'document', pendingMutations: 2 },
    ]);
  });

  test('needs-confirmation entries keep retrying shouldSkipSync while the session stays online', async () => {
    network.setOnline();
    let skipCheckEnqueuedAt: number | null = null;
    const execute = vi
      .fn<
        ({
          input,
          enqueuedAt,
        }: {
          input: { value: number };
          enqueuedAt: number;
        }) => Promise<{ value: number }>
      >()
      .mockImplementationOnce(({ input, enqueuedAt }) => {
        expect(enqueuedAt).toBe(TEST_INITIAL_TIME);
        throw new Error(`dispatch failed after send ${input.value}`);
      });
    const shouldSkipSync = vi
      .fn<
        ({
          input,
          enqueuedAt,
        }: {
          input: { value: number };
          enqueuedAt: number;
        }) => Promise<boolean>
      >()
      .mockImplementation(({ input, enqueuedAt }) => {
        skipCheckEnqueuedAt = enqueuedAt;
        expect(input.value).toBe(2);
        return Promise.resolve(true);
      });

    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      getSessionKey: () => 'online-needs-confirmation-retry-session',
      testScenario: 'loaded',
      persistentStorage: {
        storeName: 'online-needs-confirmation-retry-doc',
        adapter: 'local-sync',
        schema: docSchema,
        offlineMode: {
          network: network.config,
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute,
              shouldSkipSync,
            },
          },
        },
      },
    });

    await env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: () => Promise.resolve(2),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(shouldSkipSync).toHaveBeenCalledTimes(0);
    expect(env.apiStore.getOfflineEntities()).toMatchObject([
      {
        entityKey: 'document',
        pendingMutations: 1,
        syncState: 'needs-confirmation',
      },
    ]);

    await advanceTime(300);
    await flushAllTimers();

    expect(shouldSkipSync).toHaveBeenCalledTimes(1);
    expect(skipCheckEnqueuedAt).toBe(TEST_INITIAL_TIME);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  });

  test('session switches do not leave replayed queue entries in the old namespace', async () => {
    network.setOffline();
    let sessionKey: string | false = 'replay-session-a';
    let resolveReplay: ((result: { value: number }) => void) | undefined;

    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        storeName: 'replay-session-switch-doc',
        adapter: 'local-sync',
        schema: docSchema,
        offlineMode: {
          network: network.config,
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: () =>
                new Promise<{ value: number }>((resolve) => {
                  resolveReplay = resolve;
                }),
            },
          },
        },
      },
    });

    await env.apiStore.performMutation({
      mutation: () => Promise.resolve(2),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    expect(
      getLocalStorageKeys().filter((key) =>
        key.startsWith('tsdf.replay-session-a.replay-session-switch-doc.oq.'),
      ),
    ).toHaveLength(1);

    act(() => {
      network.goOnline();
    });
    await waitForMicrotaskCondition(() => resolveReplay !== undefined);

    expect(resolveReplay).toBeDefined();
    sessionKey = 'replay-session-b';
    resolveReplay?.({ value: 2 });
    await flushAllTimers();

    expect(
      getLocalStorageKeys().filter((key) =>
        key.startsWith('tsdf.replay-session-a.replay-session-switch-doc.oq.'),
      ),
    ).toMatchInlineSnapshot(`[]`);
  });
});
