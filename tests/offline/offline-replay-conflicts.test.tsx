import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { CollectionOfflineOperationDefinition } from '../../src/main';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { type UpdateValueConflictOperations } from './offlineReplayTestShared';
import {
  collectionCreateInputSchema,
  collectionSchema,
  docConflictSchema,
  docMutationInputSchema,
  docSchema,
} from './offlineTestShared';

async function waitForMicrotaskCondition(
  condition: () => boolean,
  maxTurns = 20,
): Promise<void> {
  for (let turn = 0; turn < maxTurns && !condition(); turn += 1) {
    await Promise.resolve();
  }
}

type CreateUserConflictOperations = {
  createUser: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { name: string },
    { reason: string },
    { id: string; name: string }
  >;
};

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
      id: 'offline-conflict-doc',
      getSessionKey: () => 'offline-conflict-session',
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
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
      id: 'offline-conflict-requeue-doc',
      getSessionKey: () => 'offline-conflict-requeue-session',
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
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

  test('resolving a temp-entity conflict keeps the original temp id when requeueing adjusted input', async () => {
    network.setOffline();
    const executeResolvers: Array<
      (result: { id: string; name: string }) => void
    > = [];
    const env = createCollectionStoreTestEnv<
      { name: string },
      CreateUserConflictOperations
    >(
      { 'users||1': { name: 'User 1' } },
      {
        getSessionKey: () => 'offline-conflict-temp-requeue-session',
        testScenario: 'loaded',
        persistentStorage: {
          adapter: 'local-sync',
          schema: collectionSchema,
          payloadSchema: rc_string,
          offlineMode: {
            network: network.config,
            operations: {
              createUser: {
                inputSchema: collectionCreateInputSchema,
                getEntityRefs: ({ input }) => [`temp:${input.name}`],
                execute: () =>
                  new Promise<{ id: string; name: string }>((resolve) => {
                    executeResolvers.push(resolve);
                  }),
                conflictHandling: {
                  schema: docConflictSchema,
                  detectConflict: ({ input }) =>
                    input.name === 'Ada' ? { reason: 'server-changed' } : false,
                  resolveConflict: ({ conflict, resolution }) => {
                    expect(conflict).toMatchObject({
                      reason: 'server-changed',
                    });
                    expect(resolution).toMatchObject({ name: 'Ada resolved' });

                    return { requeue: { input: { name: 'Ada resolved' } } };
                  },
                },
                tempEntity: {
                  buildPendingEntity: (input) => ({
                    value: { name: `pending:${input.name}` },
                  }),
                  reconcileServerEntity: (result) => ({
                    finalPayload: result.id,
                    finalData: { value: { name: result.name } },
                  }),
                },
              },
            },
          },
        },
      },
    );

    await env.apiStore.performMutation('__create__', {
      mutation: () => Promise.resolve({ value: { name: 'Ada' } }),
      offline: { operation: 'createUser', input: { name: 'Ada' } },
    });

    // Start observing the optimistic item through the public hook API once the
    // offline create has materialized it locally.
    const tempAdaHook = renderHook(() => {
      const item = env.apiStore.useItem('temp:Ada');
      env.trackItemUI('temp:Ada', item.data?.value.name ?? null);
      return item;
    });
    await flushAllTimers();

    expect(env.apiStore.getOfflineEntities()).toMatchObject([
      { entityKey: getCompositeKey('temp:Ada'), tempId: 'temp:Ada' },
    ]);
    expect(env.store.state[getCompositeKey('temp:Ada')]?.data).toMatchObject({
      value: { name: 'pending:Ada' },
    });

    // Replay the queued create. The first online attempt should stop at the
    // conflict instead of executing the mutation.
    env.addTimelineComments('beforeNextAction', [
      'replay the queued temp create and persist the conflict',
    ]);
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    const [conflict] = env.apiStore.getOfflineConflicts();
    expect(conflict).toBeDefined();
    if (!conflict) {
      throw new Error('Expected a persisted offline conflict');
    }

    // Resolve the conflict with adjusted input, but keep the original
    // optimistic temp row alive while the replacement replay is in flight.
    env.addTimelineComments('beforeNextAction', [
      'resolve the conflict with a new name while keeping the same temp row',
    ]);
    await act(async () => {
      await env.apiStore.resolveOfflineConflict(conflict.id, {
        name: 'Ada resolved',
      });
      await Promise.resolve();
    });
    await waitForMicrotaskCondition(() => executeResolvers.length === 1);

    // The replacement replay should still point at the original temp entity,
    // not create a second temp row derived from the adjusted input.
    expect({
      offlineEntities: env.apiStore
        .getOfflineEntities()
        .map((entity) => ({
          entityKey: entity.entityKey,
          tempId: entity.tempId,
        })),
      hasResolvedTempData:
        env.store.state[getCompositeKey('temp:Ada resolved')]?.data !==
        undefined,
      tempAdaData: env.store.state[getCompositeKey('temp:Ada')]?.data,
    }).toMatchInlineSnapshot(`
      hasResolvedTempData: '❌'
      offlineEntities:
        - entityKey: '"temp:Ada'
          tempId: 'temp:Ada'

      tempAdaData:
        value: { name: 'pending:Ada resolved' }
    `);
    expect(tempAdaHook.result.current.data).toMatchInlineSnapshot(`
      value: { name: 'pending:Ada resolved' }
    `);

    // Once the server accepts the replacement replay, the original temp row
    // should reconcile into the final server-backed item and disappear cleanly.
    env.addTimelineComments('beforeNextAction', [
      'server accepts the replacement replay and reconciles the temp row',
    ]);
    executeResolvers[0]?.({ id: 'users||ada-resolved', name: 'Ada resolved' });
    await flushAllTimers();

    expect(env.apiStore.getOfflineConflicts()).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    expect(env.store.state[getCompositeKey('temp:Ada')]).toBeNull();
    expect(
      env.store.state[getCompositeKey('users||ada-resolved')]?.data,
    ).toMatchObject({ value: { name: 'Ada resolved' } });
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | temp:Ada             |
      0     | pending:Ada          | ui-initialized
      1.01s | pending:Ada          | -- replay the queued temp create and persist the conflict
      .     | pending:Ada          | -- resolve the conflict with a new name while keeping the same temp row
      .     | pending:Ada resolved | ui-changed
      .     | pending:Ada resolved | -- server accepts the replacement replay and reconciles the temp row
      .     | ···                  | ui-changed
      "
    `);

    tempAdaHook.unmount();
  });
});
