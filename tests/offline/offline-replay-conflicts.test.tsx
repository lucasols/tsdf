import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { CollectionOfflineOperationDefinition } from '../../src/main';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { createOfflineConfigForSessionKey } from '../utils/offlineConfig';
import { type UpdateValueConflictOperations } from './offlineReplayTestShared';
import {
  classifyMutationOutage,
  collectionCreateInputSchema,
  collectionSchema,
  docConflictSchema,
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
  const env = createDocumentStoreTestEnv<number, UpdateValueConflictOperations>(
    1,
    {
      id: 'offline-conflict-doc',
      getSessionKey: () => 'offline-conflict-session',
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: createOfflineConfigForSessionKey(
          () => 'offline-conflict-session',
          {
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

                    expect(conflict).toMatchInlineSnapshot(
                      `reason: 'server-changed'`,
                    );

                    expect(resolution).toMatchInlineSnapshot(
                      `resolution: 'accept-local'`,
                    );
                    resolveEnqueuedAt = enqueuedAt;
                    return undefined;
                  },
                },
              },
            },
          },
        ),
      },
    },
  );

  // Queue the offline mutation while the browser is disconnected.
  await env.apiStore.performMutation({
    optimisticUpdate: () => {
      env.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: () => Promise.resolve(2),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  // Reconnect so the queued mutation can be replayed and rejected before it
  // reaches the execute callback.
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
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: 'document'
      entityKind: 'document'
      id: 'offline-conflict-session:offline-conflict-doc:document'
      pendingMutations: 0
      requiresResolution: '✅'
      sessionKey: 'offline-conflict-session'
      storeName: 'offline-conflict-doc'
      storeType: 'document'
      syncState: 'resolution-required'
      updatedAt: 1735689600000
  `);
  expect(
    env.apiStore.getOfflineResolutions().map((resolution) => {
      if (resolution.kind !== 'conflict') {
        throw new Error('Expected a persisted offline conflict');
      }

      return {
        kind: resolution.kind,
        conflict: resolution.conflict,
        createdAt: resolution.createdAt,
        enqueuedAt: resolution.enqueuedAt,
        entityRefs: resolution.entityRefs,
        input: resolution.input,
        operation: resolution.operation,
        sessionKey: resolution.sessionKey,
        storeName: resolution.storeName,
        storeType: resolution.storeType,
        updatedAt: resolution.updatedAt,
      };
    }),
  ).toMatchInlineSnapshot(`
    - conflict: { reason: 'server-changed' }
      createdAt: 1735689600000
      enqueuedAt: 1735689600000
      entityRefs:
        - { entityKey: 'document', entityKind: 'document' }
      input: { value: 2 }
      kind: 'conflict'
      operation: 'updateValue'
      sessionKey: 'offline-conflict-session'
      storeName: 'offline-conflict-doc'
      storeType: 'document'
      updatedAt: 1735689600000
  `);

  const [conflict] = env.apiStore.getOfflineResolutions();
  expect(conflict).toBeDefined();
  if (!conflict) {
    throw new Error('Expected a persisted offline conflict');
  }

  // Resolve the stored conflict and confirm the session clears its offline
  // bookkeeping once the resolution is accepted.
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(conflict.id, {
      resolution: 'accept-local',
    });
    await Promise.resolve();
    await flushAllTimers();
  });

  expect(resolveEnqueuedAt).toBe(TEST_INITIAL_TIME);
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
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
      expect(conflict).toMatchInlineSnapshot(`reason: 'server-changed'`);
      expect(enqueuedAt).toBe(TEST_INITIAL_TIME);

      expect(resolution).toMatchInlineSnapshot(`value: 7`);

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

  const env = createDocumentStoreTestEnv<number, UpdateValueConflictOperations>(
    1,
    {
      id: 'offline-conflict-requeue-doc',
      getSessionKey: () => 'offline-conflict-requeue-session',
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: createOfflineConfigForSessionKey(
          () => 'offline-conflict-requeue-session',
          {
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
        ),
      },
    },
  );

  // Queue the replay candidate while offline so we can verify the conflict
  // flow starts from a durable persisted mutation.
  await env.apiStore.performMutation({
    optimisticUpdate: () => {
      env.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: () => Promise.resolve(2),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  // Bring the session back online so the queued mutation is replayed and
  // converted into a persisted conflict instead of executing successfully.
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  const [conflict] = env.apiStore.getOfflineResolutions();
  expect(conflict).toBeDefined();
  expect(executedInputs).toMatchInlineSnapshot(`[]`);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: 'document'
      entityKind: 'document'
      id: 'offline-conflict-requeue-session:offline-conflict-requeue-doc:document'
      pendingMutations: 0
      requiresResolution: '✅'
      sessionKey: 'offline-conflict-requeue-session'
      storeName: 'offline-conflict-requeue-doc'
      storeType: 'document'
      syncState: 'resolution-required'
      updatedAt: 1735689600000
  `);

  if (!conflict) {
    throw new Error('Expected a persisted offline conflict');
  }

  // Resolve the conflict by requeueing a replacement mutation and let it run
  // immediately while the original optimistic state stays visible.
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(conflict.id, { value: 7 });
    await flushAllTimers();
  });

  expect(resolveConflict).toHaveBeenCalledTimes(1);
  expect(executedInputs).toMatchInlineSnapshot(`[7]`);
  expect(env.store.state.data).toMatchInlineSnapshot(`
    value: 7
  `);
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
});

type CreateUserConflictOperations = {
  createUser: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { name: string },
    { reason: string },
    { id: string; name: string }
  >;
};

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
        offline: createOfflineConfigForSessionKey(
          () => 'offline-conflict-temp-requeue-session',
          {
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
                    expect(conflict).toMatchInlineSnapshot(
                      `reason: 'server-changed'`,
                    );

                    expect(resolution).toMatchInlineSnapshot(
                      `name: 'Ada resolved'`,
                    );

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
        ),
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

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: '"temp:Ada'
      entityKind: 'item'
      id: 'offline-conflict-temp-requeue-session:collection-1:"temp:Ada'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'offline-conflict-temp-requeue-session'
      storeName: 'collection-1'
      storeType: 'collection'
      syncState: 'pending'
      tempId: 'temp:Ada'
      updatedAt: 1735689600000
  `);

  expect(
    env.store.state[getCompositeKey('temp:Ada')]?.data,
  ).toMatchInlineSnapshot(`value: { name: 'pending:Ada' }`);

  // Replay the queued create. The first online attempt should stop at the
  // conflict instead of executing the mutation.
  env.addTimelineComments('beforeNextAction', [
    'replay the queued temp create and persist the conflict',
  ]);
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  const [conflict] = env.apiStore.getOfflineResolutions();
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
    await env.apiStore.resolveOfflineResolution(conflict.id, {
      name: 'Ada resolved',
    });
    await Promise.resolve();
  });
  await waitForMicrotaskCondition(() => executeResolvers.length === 1);

  // The replacement replay should still point at the original temp entity,
  // not create a second temp row derived from the adjusted input.
  expect(env.apiStore.getOfflineEntities().map((entity) => entity.tempId))
    .toMatchInlineSnapshot(`
      ['temp:Ada']
    `);
  expect(env.store.state[getCompositeKey('temp:Ada resolved')]).toBeUndefined();
  expect(env.store.state[getCompositeKey('temp:Ada')]?.data)
    .toMatchInlineSnapshot(`
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

  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(env.store.state[getCompositeKey('temp:Ada')]).toBeNull();

  expect(
    env.store.state[getCompositeKey('users||ada-resolved')]?.data,
  ).toMatchInlineSnapshot(`value: { name: 'Ada resolved' }`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | temp:Ada             |
    0     | -                    | offline:createUser queued
    .     | pending:Ada          | ui-initialized
    1.01s | pending:Ada          | -- replay the queued temp create and persist the conflict
    .     | pending:Ada          | offline:createUser resolution-required
    .     | pending:Ada          | -- resolve the conflict with a new name while keeping the same temp row
    .     | pending:Ada resolved | ui-changed
    .     | pending:Ada resolved | offline:createUser replay-started
    .     | pending:Ada resolved | -- server accepts the replacement replay and reconciles the temp row
    .     | pending:Ada resolved | offline:createUser replay-finished
    .     | ···                  | ui-changed
    "
  `);

  act(() => {
    tempAdaHook.unmount();
  });
});

test('conflict handling still works for mutations queued via fallback', async () => {
  const execute = vi.fn(({ input }: { input: { value: number } }) => input);
  const env = createDocumentStoreTestEnv<number, UpdateValueConflictOperations>(
    1,
    {
      getSessionKey: () => 'hybrid-conflict-session',
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: createOfflineConfigForSessionKey(
          () => 'hybrid-conflict-session',
          {
            network: network.config,
            classifyFailure: (error, ctx) =>
              classifyMutationOutage(error, ctx.phase) ? 'outage' : 'ignore',
            outage: {
              enabled: true,
              recoveryCheck: () => true,
              recoveryProbe: quickRecoveryProbe,
            },
            operations: {
              updateValue: {
                inputSchema: docMutationInputSchema,
                execute,
                conflictHandling: {
                  detectConflict: ({ input }) =>
                    input.value === 2 ? { reason: 'server-changed' } : false,
                  resolveConflict: () => undefined,
                },
              },
            },
          },
        ),
      },
    },
  );

  // A mutation that first fails online should still enter the normal replay
  // conflict flow once it has been queued by the hybrid fallback.
  const result = await env.apiStore.performMutation({
    mutation: () => Promise.reject(new Error('offline-fallback')),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  expect({ ok: result.ok, value: result.ok ? result.value : null })
    .toMatchInlineSnapshot(`
      ok: '✅'
      value: { kind: 'queued' }
    `);

  await act(async () => {
    await advanceTime(1);
  });
  await waitForMicrotaskCondition(
    () => env.apiStore.getOfflineResolutions().length === 1,
  );

  expect(execute).not.toHaveBeenCalled();

  expect(
    env.apiStore
      .getOfflineResolutions()
      .map((resolution) => ({
        ...pick(resolution, [
          'blockedByResolutionIds',
          'blockedResolutionCount',
          'childResolutionCount',
          'childResolutionIds',
          'createdAt',
          'enqueuedAt',
          'entityRefs',
          'input',
          'kind',
          'operation',
          'sessionKey',
          'storeName',
          'storeType',
          'updatedAt',
        ]),
        conflict: resolution.kind === 'conflict' ? resolution.conflict : null,
      })),
  ).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      conflict: { reason: 'server-changed' }
      createdAt: 1735689600001
      enqueuedAt: 1735689600000
      entityRefs:
        - { entityKey: 'document', entityKind: 'document' }
      input: { value: 2 }
      kind: 'conflict'
      operation: 'updateValue'
      sessionKey: 'hybrid-conflict-session'
      storeName: 'document-2'
      storeType: 'document'
      updatedAt: 1735689600001
  `);
});
