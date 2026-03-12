import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { localPersistentStorage } from '../../src/main';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import {
  docConflictSchema,
  docMutationInputSchema,
  docSchema,
} from './offlineTestShared';
import { type UpdateValueConflictOperations } from './offlineReplayTestShared';

describe('offline replay conflict handling', () => {
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

  test('offline conflicts are detected before execute, surface through selectors, and can be resolved', async () => {
    network.setOffline();
    const execute = vi.fn(
      ({
        input,
        enqueuedAt,
      }: {
        input: { value: number };
        enqueuedAt: number;
      }) => {
        expect(input.value).toBe(2);
        expect(enqueuedAt).toBe(TEST_INITIAL_TIME);
        return input;
      },
    );
    let resolveEnqueuedAt: number | null = null;
    const env = createDocumentStoreTestEnv<
      number,
      UpdateValueConflictOperations
    >(1, {
      getSessionKey: () => 'offline-conflict-session',
      testScenario: 'loaded',
      persistentStorage: {
        storeName: 'offline-conflict-doc',
        adapter: localPersistentStorage,
        schema: docSchema,
        offlineMode: {
          network: { enabled: true },
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute,
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: ({ input, enqueuedAt }) => {
                  expect(input.value).toBe(2);
                  expect(enqueuedAt).toBe(TEST_INITIAL_TIME);
                  return { reason: 'server-changed' };
                },
                resolveConflict: ({
                  input,
                  conflict,
                  resolution,
                  enqueuedAt,
                }) => {
                  expect(input.value).toBe(2);
                  expect(conflict).toMatchObject({ reason: 'server-changed' });
                  expect(resolution).toMatchObject({
                    resolution: 'accept-local',
                  });
                  resolveEnqueuedAt = enqueuedAt;
                  return undefined;
                },
              },
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

    await act(async () => {
      network.goOnline();
      await Promise.resolve();
      await flushAllTimers();
    });

    expect(execute).not.toHaveBeenCalled();
    expect(env.store.state).toMatchInlineSnapshot(`
      data: { value: 2 }
      error: null
      refetchOnMount: '❌'
      status: 'success'
    `);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
      - createdAt: 1735689600000
        entityKey: 'document'
        entityKind: 'document'
        hasConflict: '✅'
        id: 'offline-conflict-session:offline-conflict-doc:document'
        pendingMutations: 0
        sessionKey: 'offline-conflict-session'
        storeName: 'offline-conflict-doc'
        storeType: 'document'
        syncState: 'conflict'
        updatedAt: 1735689600000
    `);
    expect(
      env.apiStore
        .getOfflineConflicts()
        .map((conflict) => ({
          conflict: conflict.conflict,
          createdAt: conflict.createdAt,
          enqueuedAt: conflict.enqueuedAt,
          entityRefs: conflict.entityRefs,
          input: conflict.input,
          operation: conflict.operation,
          sessionKey: conflict.sessionKey,
          storeName: conflict.storeName,
          storeType: conflict.storeType,
          updatedAt: conflict.updatedAt,
        })),
    ).toMatchInlineSnapshot(`
      - conflict: { reason: 'server-changed' }
        createdAt: 1735689600000
        enqueuedAt: 1735689600000
        entityRefs:
          - { entityKey: 'document', entityKind: 'document' }
        input: { value: 2 }
        operation: 'updateValue'
        sessionKey: 'offline-conflict-session'
        storeName: 'offline-conflict-doc'
        storeType: 'document'
        updatedAt: 1735689600000
    `);

    const [conflict] = env.apiStore.getOfflineConflicts();
    expect(conflict).toBeDefined();
    if (!conflict) {
      throw new Error('Expected a persisted offline conflict');
    }

    await act(async () => {
      await env.apiStore.resolveOfflineConflict(conflict.id, {
        resolution: 'accept-local',
      });
      await Promise.resolve();
      await flushAllTimers();
    });

    expect(resolveEnqueuedAt).toBe(TEST_INITIAL_TIME);
    expect(env.apiStore.getOfflineConflicts()).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    expect(env.store.state).toMatchInlineSnapshot(`
      data: { value: 2 }
      error: null
      refetchOnMount: '❌'
      status: 'success'
    `);
  });

  test('resolving a persisted conflict can requeue a replacement mutation and replay it immediately', async () => {
    network.setOffline();
    const executedInputs: number[] = [];
    const resolveConflict = vi.fn(
      ({
        conflict,
        resolution,
        enqueuedAt,
      }: {
        conflict: { reason: string };
        resolution: unknown;
        enqueuedAt: number;
      }) => {
        expect(conflict).toMatchObject({ reason: 'server-changed' });
        expect(enqueuedAt).toBe(TEST_INITIAL_TIME);
        expect(resolution).toMatchObject({ value: 7 });

        if (typeof resolution !== 'object' || resolution === null) {
          throw new Error('Expected a numeric conflict resolution payload');
        }
        const nextValue = Reflect.get(resolution, 'value');
        if (typeof nextValue !== 'number') {
          throw new Error('Expected a numeric conflict resolution payload');
        }

        return { requeue: { input: { value: nextValue } } };
      },
    );

    const env = createDocumentStoreTestEnv<
      number,
      UpdateValueConflictOperations
    >(1, {
      getSessionKey: () => 'offline-conflict-requeue-session',
      testScenario: 'loaded',
      persistentStorage: {
        storeName: 'offline-conflict-requeue-doc',
        adapter: localPersistentStorage,
        schema: docSchema,
        offlineMode: {
          network: network.config,
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: ({ input }) => {
                executedInputs.push(input.value);
                env.apiStore.updateState((draft) => {
                  draft.value = input.value;
                });
                return input;
              },
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: ({ input }) =>
                  input.value === 2 ? { reason: 'server-changed' } : false,
                resolveConflict,
              },
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
    await flushAllTimers();

    const [conflict] = env.apiStore.getOfflineConflicts();
    expect(conflict).toBeDefined();
    expect(executedInputs).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
      - createdAt: 1735689600000
        entityKey: 'document'
        entityKind: 'document'
        hasConflict: '✅'
        id: 'offline-conflict-requeue-session:offline-conflict-requeue-doc:document'
        pendingMutations: 0
        sessionKey: 'offline-conflict-requeue-session'
        storeName: 'offline-conflict-requeue-doc'
        storeType: 'document'
        syncState: 'conflict'
        updatedAt: 1735689600000
    `);

    if (!conflict) {
      throw new Error('Expected a persisted offline conflict');
    }

    await act(async () => {
      await env.apiStore.resolveOfflineConflict(conflict.id, { value: 7 });
      await flushAllTimers();
    });

    expect(resolveConflict).toHaveBeenCalledTimes(1);
    expect(executedInputs).toMatchInlineSnapshot(`[7]`);
    expect(env.store.state.data).toMatchInlineSnapshot(`
      value: 7
    `);
    expect(env.apiStore.getOfflineConflicts()).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  });
});
