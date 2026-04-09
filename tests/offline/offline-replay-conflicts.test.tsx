import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  type CollectionOfflineOperationDefinition,
  createOfflineSession,
  getGlobalOfflineStatus,
  type ListQueryOfflineOperationDefinition,
  type OfflineResolutionRecord,
  useGlobalOfflineEntities,
  useGlobalOfflineResolutions,
} from '../../src/main';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import {
  getLocalStorageKeys,
  type PatchUserOperations,
  type UpdateValueConflictOperations,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  classifyMutationOutage,
  collectionCreateInputSchema,
  collectionSchema,
  docConflictSchema,
  docMutationInputSchema,
  docSchema,
  listQueryQueryPayloadSchema,
  parsePersistedObject,
  quickRecoveryProbe,
  summarizeResolution,
  toRecord,
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

type OfflineEntitySummaryInput = {
  blockedByResolutionIds: string[];
  blockedResolutionCount: number;
  childResolutionCount: number;
  childResolutionIds: string[];
  createdAt: number;
  entityKey: string;
  entityKind: string;
  id: string;
  pendingMutations: number;
  requiresResolution: boolean;
  sessionKey: string;
  storeName: string;
  storeType: string;
  syncState: string;
  tempId?: unknown;
  updatedAt: number;
};

function summarizeOfflineEntities(
  entities: readonly OfflineEntitySummaryInput[],
) {
  return entities.map((entity) => ({
    ...pick(entity, [
      'blockedByResolutionIds',
      'blockedResolutionCount',
      'childResolutionCount',
      'childResolutionIds',
      'createdAt',
      'entityKey',
      'entityKind',
      'id',
      'pendingMutations',
      'requiresResolution',
      'sessionKey',
      'storeName',
      'storeType',
      'syncState',
      'updatedAt',
    ]),
    ...(entity.tempId === undefined ? {} : { tempId: entity.tempId }),
  }));
}

function summarizeConflictResolution(resolution: OfflineResolutionRecord) {
  if (resolution.kind !== 'conflict') {
    throw new Error('Expected a persisted offline conflict');
  }

  return {
    conflict: resolution.conflict,
    createdAt: resolution.createdAt,
    enqueuedAt: resolution.enqueuedAt,
    entityRefs: resolution.entityRefs,
    input: resolution.input,
    kind: resolution.kind,
    operation: resolution.operation,
    sessionKey: resolution.sessionKey,
    storeName: resolution.storeName,
    storeType: resolution.storeType,
    updatedAt: resolution.updatedAt,
  };
}

function summarizeDetailedConflictResolution(
  resolution: OfflineResolutionRecord,
) {
  return {
    ...pick(resolution, [
      'blockedByResolutionIds',
      'blockedResolutionCount',
      'childResolutionCount',
      'childResolutionIds',
    ]),
    ...summarizeConflictResolution(resolution),
  };
}

function getSingleConflictResolution<T extends { id: string; kind: string }>(
  resolutions: readonly T[],
) {
  expect(resolutions).toHaveLength(1);
  const [conflict] = resolutions;

  if (!conflict) {
    throw new Error('Expected a persisted offline conflict');
  }

  if (conflict.kind !== 'conflict') {
    throw new Error('Expected a persisted offline conflict');
  }

  return conflict;
}

test('offline conflicts are detected before execute, surface through selectors, and can be committed externally', async () => {
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
      return env.serverMock.delayedSetData(input.value).then(() => input);
    },
  );
  const env = createDocumentStoreTestEnv<number, UpdateValueConflictOperations>(
    1,
    {
      id: 'offline-conflict-doc',
      getSessionKey: () => 'offline-conflict-session',
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => 'offline-conflict-session',
            config: { network: { enabled: true } },
          }),
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute,
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateState((draft) => {
                  draft.value = input.value;
                });
              },
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: ({ input, enqueuedAt }) => {
                  expect(input.value).toBe(2);
                  expect(enqueuedAt).toBe(TEST_INITIAL_TIME);
                  return { reason: 'server-changed' };
                },
              },
            },
          },
        },
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
    mutation: async () => {
      await env.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  // Reconnect so the queued mutation can be replayed and rejected before it
  // reaches the execute callback.
  env.addTimelineComments('beforeNextAction', [
    'reconnect and stop the queued mutation at conflict detection before execute runs',
  ]);
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
    await flushAllTimers();
  });
  const storeOfflineHook = renderHook(() => env.apiStore.useOfflineEntities());
  const storeResolutionHook = renderHook(() =>
    env.apiStore.useOfflineResolutions(),
  );
  const globalOfflineHook = renderHook(() =>
    useGlobalOfflineEntities('offline-conflict-session'),
  );
  const globalResolutionHook = renderHook(() =>
    useGlobalOfflineResolutions('offline-conflict-session'),
  );

  expect(execute).not.toHaveBeenCalled();
  expect(env.store.state).toMatchInlineSnapshot(`
    data: { value: 2 }
    error: null
    refetchOnMount: '❌'
    status: 'success'
  `);
  expect(summarizeOfflineEntities(storeOfflineHook.result.current))
    .toMatchInlineSnapshot(`
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
  expect(globalOfflineHook.result.current).toEqual(
    storeOfflineHook.result.current,
  );
  expect(storeResolutionHook.result.current.map(summarizeConflictResolution))
    .toMatchInlineSnapshot(`
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
  expect(storeResolutionHook.result.current.map(summarizeResolution))
    .toMatchInlineSnapshot(`
      - input: 'value: 2'
        kind: 'conflict'
        on: 'document:document'
        op: 'updateValue'
        reason: 'server-changed'
    `);
  expect(globalResolutionHook.result.current).toEqual(
    storeResolutionHook.result.current,
  );
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time |
    0    | offline:updateValue queued
    .    | -- reconnect and stop the queued mutation at conflict detection before execute runs
    .    | offline:updateValue resolution-required
    "
  `);
  const conflict = getSingleConflictResolution(
    storeResolutionHook.result.current,
  );

  // Simulate an external conflict-resolution API call that accepts the
  // optimistic value, then commit that accepted outcome back into the store so
  // it can clear bookkeeping without replaying the mutation internally.
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(conflict.id, 'updateValue', {
      action: 'commit',
    });
    await Promise.resolve();
    await flushAllTimers();
  });

  expect(storeResolutionHook.result.current).toMatchInlineSnapshot(`[]`);
  expect(globalResolutionHook.result.current).toMatchInlineSnapshot(`[]`);
  expect(storeOfflineHook.result.current).toMatchInlineSnapshot(`[]`);
  expect(globalOfflineHook.result.current).toMatchInlineSnapshot(`[]`);
  expect(env.store.state).toMatchInlineSnapshot(`
    data: { value: 2 }
    error: null
    refetchOnMount: '❌'
    status: 'success'
  `);
  storeOfflineHook.unmount();
  storeResolutionHook.unmount();
  globalOfflineHook.unmount();
  globalResolutionHook.unmount();
});

test('resolving a persisted conflict can requeue a replacement mutation and replay it immediately', async () => {
  network.setOffline();
  const executedInputs: number[] = [];

  const env = createDocumentStoreTestEnv<number, UpdateValueConflictOperations>(
    1,
    {
      id: 'offline-conflict-requeue-doc',
      getSessionKey: () => 'offline-conflict-requeue-session',
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => 'offline-conflict-requeue-session',
            config: { network: network.config },
          }),
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: async ({ input }) => {
                executedInputs.push(input.value);
                await env.serverMock.delayedSetData(input.value);
                return input;
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateState((draft) => {
                  draft.value = input.value;
                });
              },
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: ({ input }) =>
                  input.value === 2 ? { reason: 'server-changed' } : false,
              },
            },
          },
        },
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
    mutation: async () => {
      await env.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  // Bring the session back online so the queued mutation is replayed and
  // converted into a persisted conflict instead of executing successfully.
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();
  const storeOfflineHook = renderHook(() => env.apiStore.useOfflineEntities());
  const storeResolutionHook = renderHook(() =>
    env.apiStore.useOfflineResolutions(),
  );

  const conflict = getSingleConflictResolution(
    storeResolutionHook.result.current,
  );
  expect(summarizeResolution(conflict)).toMatchInlineSnapshot(`
    input: 'value: 2'
    kind: 'conflict'
    on: 'document:document'
    op: 'updateValue'
    reason: 'server-changed'
  `);
  expect(executedInputs).toMatchInlineSnapshot(`[]`);
  expect(summarizeOfflineEntities(storeOfflineHook.result.current))
    .toMatchInlineSnapshot(`
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

  // Resolve the conflict by requeueing a replacement mutation and let it run
  // immediately while the original optimistic state stays visible.
  env.addTimelineComments('beforeNextAction', [
    'resolve the conflict with a replacement value and replay it immediately',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(conflict.id, 'updateValue', {
      action: 'requeue',
      input: { value: 7 },
    });
    await flushAllTimers();
  });

  expect(executedInputs).toMatchInlineSnapshot(`[7]`);
  expect(env.store.state.data).toMatchInlineSnapshot(`
    value: 7
  `);
  expect(storeResolutionHook.result.current).toMatchInlineSnapshot(`[]`);
  expect(storeOfflineHook.result.current).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time |
    0    | offline:updateValue queued
    .    | offline:updateValue resolution-required
    1s   | -- resolve the conflict with a replacement value and replay it immediately
    .    | offline:updateValue replay-started
    2.2s | server-data-changed (value: 7)
    .    | offline:updateValue replay-finished
    "
  `);
  storeOfflineHook.unmount();
  storeResolutionHook.unmount();
});

test('invalid persisted conflict payloads remain hydrated and decode to error through the parser helper', async () => {
  network.setOffline();
  const sessionKey = 'offline-conflict-hydration-session';
  const storeName = 'offline-conflict-hydration-doc';

  const env = createDocumentStoreTestEnv<number, UpdateValueConflictOperations>(
    1,
    {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => sessionKey,
            config: { network: network.config },
          }),
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: async ({ input }) => {
                await env.serverMock.delayedSetData(input.value);
                return input;
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateState((draft) => {
                  draft.value = input.value;
                });
              },
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: ({ input }) =>
                  input.value === 2 ? { reason: 'server-changed' } : false,
              },
            },
          },
        },
      },
    },
  );

  await env.apiStore.performMutation({
    optimisticUpdate: () => {
      env.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: async () => {
      await env.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(env.apiStore.getOfflineResolutions()).toHaveLength(1);

  const persistedResolutionKey = getLocalStorageKeys().find((key) =>
    key.startsWith(`tsdf.${sessionKey}.${storeName}.oc.`),
  );
  if (!persistedResolutionKey) {
    throw new Error('Expected one persisted offline conflict entry');
  }

  const persistedResolutionRaw = localStorage.getItem(persistedResolutionKey);
  if (!persistedResolutionRaw) {
    throw new Error('Expected persisted offline conflict payload');
  }

  const persistedResolution = parsePersistedObject(persistedResolutionRaw);
  const persistedResolutionData = toRecord(
    'd' in persistedResolution
      ? persistedResolution.d
      : persistedResolution.data,
    'Expected persisted offline conflict payload to be an object',
  );
  localStorage.setItem(
    persistedResolutionKey,
    JSON.stringify({
      ...persistedResolution,
      d: { ...persistedResolutionData, conflict: { wrong: 'shape' } },
    }),
  );

  const rehydratedEnv = createDocumentStoreTestEnv<
    number,
    UpdateValueConflictOperations
  >(1, {
    id: storeName,
    getSessionKey: () => sessionKey,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () => sessionKey,
          config: { network: network.config },
        }),
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            execute: async ({ input }) => {
              await env.serverMock.delayedSetData(input.value);
              return input;
            },
            onSuccessExecute: ({ input }) => {
              env.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
            },
            conflictHandling: {
              schema: docConflictSchema,
              detectConflict: ({ input }) =>
                input.value === 2 ? { reason: 'server-changed' } : false,
            },
          },
        },
      },
    },
  });

  await flushAllTimers();

  const [rehydratedResolution] = rehydratedEnv.apiStore.getOfflineResolutions();
  if (!rehydratedResolution || rehydratedResolution.kind !== 'conflict') {
    throw new Error('Expected one rehydrated conflict resolution');
  }

  expect(rehydratedEnv.apiStore.getOfflineResolutions()).toHaveLength(1);
  expect(summarizeResolution(rehydratedResolution)).toMatchInlineSnapshot(`
    input: 'value: 2'
    kind: 'conflict'
    on: 'document:document'
    op: 'updateValue'
    reason: 'wrong: "shape"'
  `);
  const result =
    rehydratedEnv.apiStore.parseOfflineResolutionConflict(rehydratedResolution);
  assert(!result.ok);
  expect(result.error).toBeInstanceOf(Error);
  expect({
    code: result.error.code,
    error: result.error,
    validationIssues: result.error.validationError,
  }).toMatchInlineSnapshot(`
    code: 'invalid-conflict-payload'

    error{Error}:
      message: "$.reason: Type 'undefined' is not assignable to 'string'"
      name: 'OfflineResolutionConflictParseError'
      code: 'invalid-conflict-payload'
      operation: 'updateValue'
      rawValue: { wrong: 'shape' }
      validationError: ["$.reason: Type 'undefined' is not assignable to 'string'"]

    validationIssues: ["$.reason: Type 'undefined' is not assignable to 'string'"]
  `);
  expect(rehydratedEnv.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: 'document'
      entityKind: 'document'
      id: 'offline-conflict-hydration-session:offline-conflict-hydration-doc:document'
      pendingMutations: 0
      requiresResolution: '✅'
      sessionKey: 'offline-conflict-hydration-session'
      storeName: 'offline-conflict-hydration-doc'
      storeType: 'document'
      syncState: 'resolution-required'
      updatedAt: 1735689600000
  `);
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
        offline: {
          session: createOfflineSession({
            getSessionKey: () => 'offline-conflict-temp-requeue-session',
            config: { network: network.config },
          }),
          operations: {
            createUser: {
              inputSchema: collectionCreateInputSchema,
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              execute: () =>
                new Promise<{ id: string; name: string }>((resolve) => {
                  executeResolvers.push((result) => {
                    void env.serverTable
                      .delayedSetItem(result.id, { name: result.name })
                      .then(() => {
                        resolve(result);
                      });
                  });
                }),
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: ({ input }) =>
                  input.name === 'Ada' ? { reason: 'server-changed' } : false,
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
  await env.apiStore.performMutation(null, {
    mutation: async () => {
      const result = { id: 'users||ada', name: 'Ada' };
      await env.serverTable.delayedSetItem(result.id, { name: result.name });
      return result;
    },
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
  const offlineEntitiesHook = renderHook(() =>
    env.apiStore.useOfflineEntities(),
  );
  const storeEvents: unknown[] = [];

  env.apiStore.storeEvents.on('*', (event) => {
    storeEvents.push(event);
  });

  expect(summarizeOfflineEntities(offlineEntitiesHook.result.current))
    .toMatchInlineSnapshot(`
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
  const offlineResolutionsHook = renderHook(() =>
    env.apiStore.useOfflineResolutions(),
  );

  const conflict = getSingleConflictResolution(
    offlineResolutionsHook.result.current,
  );
  expect(summarizeResolution(conflict)).toMatchInlineSnapshot(`
    input: 'name: "Ada"'
    kind: 'conflict'
    on: 'item:temp:Ada'
    op: 'createUser'
    reason: 'server-changed'
    tempIds: ['temp:Ada']
  `);

  // Resolve the conflict with adjusted input, but keep the original
  // optimistic temp row alive while the replacement replay is in flight.
  env.addTimelineComments('beforeNextAction', [
    'resolve the conflict with a new name while keeping the same temp row',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(conflict.id, 'createUser', {
      action: 'requeue',
      input: { name: 'Ada resolved' },
    });
    await Promise.resolve();
  });
  await waitForMicrotaskCondition(() => executeResolvers.length === 1);

  // The replacement replay should still point at the original temp entity,
  // not create a second temp row derived from the adjusted input.
  expect(offlineEntitiesHook.result.current.map((entity) => entity.tempId))
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

  expect(offlineResolutionsHook.result.current).toMatchInlineSnapshot(`[]`);
  expect(offlineEntitiesHook.result.current).toMatchInlineSnapshot(`[]`);
  expect(env.store.state[getCompositeKey('temp:Ada')]).toBeNull();

  expect(
    env.store.state[getCompositeKey('users||ada-resolved')]?.data,
  ).toMatchInlineSnapshot(`value: { name: 'Ada resolved' }`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | temp:Ada             |
    0     | -                    | offline:createUser queued
    .     | pending:Ada          | [temp:Ada] ui-initialized
    1.01s | pending:Ada          | -- replay the queued temp create and persist the conflict
    .     | pending:Ada          | offline:createUser resolution-required
    .     | pending:Ada          | -- resolve the conflict with a new name while keeping the same temp row
    .     | pending:Ada resolved | [temp:Ada] ui-changed
    .     | pending:Ada resolved | offline:createUser replay-started
    2.21s | pending:Ada resolved | -- server accepts the replacement replay and reconciles the temp row
    .     | pending:Ada resolved | [users||ada-resolved] server-data-changed (value: {"name":"Ada resolved"})
    .     | pending:Ada resolved | offline:createUser replay-finished
    .     | ···                  | [temp:Ada] ui-changed
    "
  `);

  act(() => {
    offlineEntitiesHook.unmount();
    offlineResolutionsHook.unmount();
    tempAdaHook.unmount();
  });
});

test('committing a temp-entity conflict with an external result reconciles the original temp row', async () => {
  network.setOffline();
  const execute = vi.fn<() => Promise<{ id: string; name: string }>>();
  const env = createCollectionStoreTestEnv<
    { name: string },
    CreateUserConflictOperations
  >(
    { 'users||1': { name: 'User 1' } },
    {
      getSessionKey: () => 'offline-conflict-temp-commit-session',
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => 'offline-conflict-temp-commit-session',
            config: { network: network.config },
          }),
          operations: {
            createUser: {
              inputSchema: collectionCreateInputSchema,
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              execute,
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: ({ input }) =>
                  input.name === 'Ada' ? { reason: 'server-changed' } : false,
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
  execute.mockImplementation(async () => {
    const result = { id: 'users||should-not-run', name: 'Should not run' };
    await env.serverTable.delayedSetItem(result.id, { name: result.name });
    return result;
  });

  await env.apiStore.performMutation(null, {
    mutation: async () => {
      const result = { id: 'users||ada', name: 'Ada' };
      await env.serverTable.delayedSetItem(result.id, { name: result.name });
      return result;
    },
    offline: { operation: 'createUser', input: { name: 'Ada' } },
  });

  const tempAdaHook = renderHook(() => env.apiStore.useItem('temp:Ada'));
  await flushAllTimers();

  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  const conflict = getSingleConflictResolution(
    env.apiStore.getOfflineResolutions(),
  );
  expect(summarizeResolution(conflict)).toMatchInlineSnapshot(`
    input: 'name: "Ada"'
    kind: 'conflict'
    on: 'item:temp:Ada'
    op: 'createUser'
    reason: 'server-changed'
    tempIds: ['temp:Ada']
  `);

  env.addTimelineComments('afterLastAction', [
    'commit the conflict using an externally accepted server result',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(conflict.id, 'createUser', {
      action: 'commit',
      result: { id: 'users||ada-committed', name: 'Ada committed' },
    });
    await flushAllTimers();
  });

  expect(execute).not.toHaveBeenCalled();
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(env.store.state[getCompositeKey('temp:Ada')]).toBeNull();
  expect(tempAdaHook.result.current.data).toBeNull();
  expect(env.store.state[getCompositeKey('users||ada-committed')]?.data)
    .toMatchInlineSnapshot(`
      value: { name: 'Ada committed' }
    `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    0     | offline:createUser queued
    1.01s | offline:createUser resolution-required
    .     | -- commit the conflict using an externally accepted server result
    "
  `);

  tempAdaHook.unmount();
});

type CreateAndPatchListQueryUserConflictOperations = PatchUserOperations & {
  createUser: ListQueryOfflineOperationDefinition<
    { id: number; name: string },
    ListQueryParams,
    string,
    { name: string },
    { reason: string },
    { id: number; name: string }
  >;
};

test('list-query temp-create conflicts promote dependent edits into blocked resolutions that the UI can inspect', async () => {
  network.setOffline();
  const usersQuery = { tableId: 'users' } as const;
  const createUserExecute = vi.fn(
    async ({ input }: { input: { name: string } }) => {
      const result = { id: 3, name: input.name };
      await env.serverTable.delayedSetItem('users||3', result);
      return result;
    },
  );
  const patchUserExecute = vi.fn(
    async ({ input }: { input: { itemId: string; name: string } }) => {
      await env.serverTable.delayedUpdateItem(input.itemId, {
        name: input.name,
      });
      return { name: input.name };
    },
  );

  const env: ReturnType<
    typeof createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      CreateAndPatchListQueryUserConflictOperations
    >
  > = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    CreateAndPatchListQueryUserConflictOperations
  >(
    {
      users: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
    },
    {
      id: 'offline-replay-temp-create-conflict-chain-store',
      getSessionKey: () => 'offline-replay-temp-create-conflict-chain-session',
      testScenario: { loaded: { queries: [usersQuery] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () =>
              'offline-replay-temp-create-conflict-chain-session',
            config: { network: network.config },
          }),
          operations: {
            createUser: {
              inputSchema: collectionCreateInputSchema,
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              tempEntity: {
                buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                reconcileServerEntity: (result) => ({
                  finalPayload: `users||${result.id}`,
                  finalData: result,
                }),
              },
              execute: createUserExecute,
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: ({ input }) =>
                  input.name === 'Linus offline'
                    ? { reason: 'server-changed' }
                    : false,
              },
            },
            patchUserName: {
              inputSchema: userPatchSchema,
              getEntityRefs: ({ input }) => [input.itemId],
              execute: patchUserExecute,
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateItemState(input.itemId, (item) => ({
                  ...item,
                  name: input.name,
                }));
              },
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      itemSelector: (item) => item.name,
    });

    env.trackItemUI('query-items', query.items.join(', '));
    env.trackItemUI('query-status', query.status);
    return query;
  });
  await flushAllTimers();

  // Queue the temp create and the dependent edit while offline so the child
  // mutation has to wait on the temp entity lifecycle.
  env.addTimelineComments('beforeNextAction', [
    'queue the temp create and a dependent edit while offline',
  ]);
  await act(async () => {
    await env.apiStore.performMutation(null, {
      optimisticUpdate: () => {
        env.apiStore.addItemToState(
          'temp:Linus offline',
          { id: -1, name: 'Linus offline' },
          { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
        );
      },
      mutation: async () => {
        const result = { id: 3, name: 'Linus offline' };
        await env.serverTable.delayedSetItem('users||3', result);
        return result;
      },
      offline: { operation: 'createUser', input: { name: 'Linus offline' } },
    });
  });

  await act(async () => {
    await env.apiStore.performMutation('temp:Linus offline', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('temp:Linus offline', (item) => ({
          ...item,
          name: 'Linus blocked edit',
        }));
      },
      mutation: async () => {
        await env.serverTable.delayedUpdateItem('temp:Linus offline', {
          name: 'Linus blocked edit',
        });
        return { name: 'Linus blocked edit' };
      },
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'temp:Linus offline', name: 'Linus blocked edit' },
      },
    });
  });

  // Bring the session online. The temp create should stop at conflict
  // detection, and the dependent edit should be promoted into a blocked
  // child resolution that a conflict UI can inspect through hooks.
  env.addTimelineComments('beforeNextAction', [
    'go online and let the temp create stop at conflict detection',
  ]);
  act(() => {
    network.goOnline();
  });
  await waitForMicrotaskCondition(
    () => env.apiStore.getOfflineResolutions().length === 2,
  );
  await flushAllTimers();

  const offlineEntitiesHook = renderHook(() =>
    env.apiStore.useOfflineEntities(),
  );
  const offlineResolutionsHook = renderHook(() =>
    env.apiStore.useOfflineResolutions(),
  );

  const parentResolution = offlineResolutionsHook.result.current.find(
    (resolution) => resolution.operation === 'createUser',
  );
  const childResolution = offlineResolutionsHook.result.current.find(
    (resolution) => resolution.operation === 'patchUserName',
  );

  expect(parentResolution).toBeDefined();
  expect(childResolution).toBeDefined();
  if (!parentResolution || !childResolution) {
    throw new Error('Expected temp-create parent and child resolutions');
  }

  expect(createUserExecute).not.toHaveBeenCalled();
  expect(patchUserExecute).not.toHaveBeenCalled();
  expect(hook.result.current.items).toMatchInlineSnapshot(`
    ['Ada', 'Grace', 'Linus blocked edit']
  `);
  expect(parentResolution.childResolutionIds).toHaveLength(1);
  expect(parentResolution.childResolutionIds[0]).toBe(childResolution.id);
  expect(offlineResolutionsHook.result.current.map(summarizeResolution))
    .toMatchInlineSnapshot(`
      - blocks: 1
        input: 'name: "Linus offline"'
        kind: 'conflict'
        on: 'item:temp:Linus offline'
        op: 'createUser'
        reason: 'server-changed'
        tempIds: ['temp:Linus offline']
      - blockedBy: 1
        error: 'Blocked by unresolved dependency'
        input: 'itemId: "temp:Linus offline", name: "Linus blocked edit"'
        kind: 'retry-exhausted'
        on: 'item:temp:Linus offline'
        op: 'patchUserName'
    `);

  expect({
    ...pick(parentResolution, [
      'blockedByResolutionIds',
      'blockedResolutionCount',
      'childResolutionCount',
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
    conflict:
      parentResolution.kind === 'conflict' ? parentResolution.conflict : null,
    tempIds: 'tempIds' in parentResolution ? parentResolution.tempIds : null,
  }).toMatchInlineSnapshot(`
    blockedByResolutionIds: []
    blockedResolutionCount: 0
    childResolutionCount: 1
    conflict: { reason: 'server-changed' }
    createdAt: 1735689603010
    enqueuedAt: 1735689603010
    entityRefs:
      - entityKey: '"temp:Linus offline'
        entityKind: 'item'
    input: { name: 'Linus offline' }
    kind: 'conflict'
    operation: 'createUser'
    sessionKey: 'offline-replay-temp-create-conflict-chain-session'
    storeName: 'offline-replay-temp-create-conflict-chain-store'
    storeType: 'listQuery'
    tempIds: ['temp:Linus offline']
    updatedAt: 1735689603010
  `);

  expect(childResolution.blockedByResolutionIds).toHaveLength(1);
  expect(childResolution.blockedByResolutionIds[0]).toBe(parentResolution.id);
  expect(childResolution.childResolutionIds).toMatchInlineSnapshot(`[]`);
  expect(summarizeResolution(childResolution)).toMatchInlineSnapshot(`
    blockedBy: 1
    error: 'Blocked by unresolved dependency'
    input: 'itemId: "temp:Linus offline", name: "Linus blocked edit"'
    kind: 'retry-exhausted'
    on: 'item:temp:Linus offline'
    op: 'patchUserName'
  `);

  const [tempEntity] = offlineEntitiesHook.result.current;
  expect(tempEntity?.blockedByResolutionIds).toHaveLength(1);
  expect(tempEntity?.blockedByResolutionIds[0]).toBe(parentResolution.id);
  expect(tempEntity?.childResolutionIds).toHaveLength(1);
  expect(tempEntity?.childResolutionIds[0]).toBe(childResolution.id);
  expect(
    pick(tempEntity, [
      'blockedResolutionCount',
      'childResolutionCount',
      'createdAt',
      'entityKey',
      'entityKind',
      'id',
      'pendingMutations',
      'requiresResolution',
      'sessionKey',
      'storeName',
      'storeType',
      'syncState',
      'tempId',
      'updatedAt',
    ]),
  ).toMatchInlineSnapshot(`
    blockedResolutionCount: 1
    childResolutionCount: 1
    createdAt: 1735689603010
    entityKey: '"temp:Linus offline'
    entityKind: 'item'
    id: 'offline-replay-temp-create-conflict-chain-session:offline-replay-temp-create-conflict-chain-store:"temp:Linus offline'
    pendingMutations: 0
    requiresResolution: '✅'
    sessionKey: 'offline-replay-temp-create-conflict-chain-session'
    storeName: 'offline-replay-temp-create-conflict-chain-store'
    storeType: 'listQuery'
    syncState: 'resolution-required'
    tempId: 'temp:Linus offline'
    updatedAt: 1735689603010
  `);

  await expect(
    env.apiStore.resolveOfflineResolution(childResolution.id, 'patchUserName', {
      action: 'retry',
    }),
  ).rejects.toThrow(
    'Cannot resolve a blocked offline resolution before its blocking dependencies are cleared',
  );

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | query-items                    | query-status |
    0     | Ada, Grace                     | success      | [query-items, query-status] ui-initialized
    3.01s | Ada, Grace                     | success      | -- queue the temp create and a dependent edit while offline
    .     | Ada, Grace, Linus offline      | success      | [query-items] ui-changed
    .     | Ada, Grace, Linus offline      | success      | offline:createUser queued
    .     | Ada, Grace, Linus blocked edit | success      | [query-items] ui-changed
    .     | Ada, Grace, Linus blocked edit | success      | offline:patchUserName queued
    .     | Ada, Grace, Linus blocked edit | success      | -- go online and let the temp create stop at conflict detection
    .     | Ada, Grace, Linus blocked edit | success      | offline:createUser resolution-required
    .     | Ada, Grace, Linus blocked edit | success      | offline:patchUserName resolution-required
    "
  `);

  hook.unmount();
  offlineEntitiesHook.unmount();
  offlineResolutionsHook.unmount();
});

test('mutations queued via hybrid fallback still enter the normal conflict resolution flow on replay', async () => {
  const execute = vi.fn(async ({ input }: { input: { value: number } }) => {
    await env.serverMock.delayedSetData(input.value);
    return input;
  });
  const env = createDocumentStoreTestEnv<number, UpdateValueConflictOperations>(
    1,
    {
      getSessionKey: () => 'hybrid-conflict-session',
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => 'hybrid-conflict-session',
            config: {
              network: network.config,
              classifyFailure: (error, ctx) =>
                classifyMutationOutage(error, ctx.phase) ? 'outage' : 'ignore',
              outage: {
                enabled: true,
                recoveryCheck: () => true,
                recoveryProbe: quickRecoveryProbe,
              },
            },
          }),
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute,
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateState((draft) => {
                  draft.value = input.value;
                });
              },
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: ({ input }) =>
                  input.value === 2 ? { reason: 'server-changed' } : false,
              },
            },
          },
        },
      },
    },
  );
  // This first fails through the "online" mutation path, so the hybrid
  // fallback queues it offline instead of treating it as a final failure.
  // When replay runs on the next recovery tick, the queued mutation should
  // still take the normal conflict path: detect the conflict, stop replay,
  // and create a resolution for the UI.
  const result = await env.apiStore.performMutation({
    mutation: () => Promise.reject(new Error('offline-fallback')),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  expect({ ok: result.ok, value: result.ok ? result.value : null })
    .toMatchInlineSnapshot(`
      ok: '✅'
      value: { kind: 'queued' }
    `);
  expect(
    pick(getGlobalOfflineStatus('hybrid-conflict-session'), [
      'isOfflineMode',
      'network',
      'outage',
      'sessionKey',
    ]),
  ).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '❌', enabled: '✅' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'hybrid-conflict-session'
  `);

  await act(async () => {
    await advanceTime(1);
  });
  await waitForMicrotaskCondition(
    () => env.apiStore.getOfflineResolutions().length === 1,
  );
  const storeOfflineHook = renderHook(() => env.apiStore.useOfflineEntities());
  const storeResolutionHook = renderHook(() =>
    env.apiStore.useOfflineResolutions(),
  );

  // Replay should stop at conflict detection, so the operation never reaches
  // the executor and the entity becomes blocked on a user-facing resolution.
  expect(execute).not.toHaveBeenCalled();
  expect(summarizeOfflineEntities(storeOfflineHook.result.current))
    .toMatchInlineSnapshot(`
      - blockedByResolutionIds: []
        blockedResolutionCount: 0
        childResolutionCount: 0
        childResolutionIds: []
        createdAt: 1735689600001
        entityKey: 'document'
        entityKind: 'document'
        id: 'hybrid-conflict-session:document-3:document'
        pendingMutations: 0
        requiresResolution: '✅'
        sessionKey: 'hybrid-conflict-session'
        storeName: 'document-3'
        storeType: 'document'
        syncState: 'resolution-required'
        updatedAt: 1735689600001
    `);
  env.addTimelineComments('afterLastAction', [
    'the queued fallback mutation reaches replay, hits conflict detection, and becomes a pending resolution',
  ]);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time |
    0    | offline:updateValue queued
    1ms  | offline:updateValue resolution-required
    .    | -- the queued fallback mutation reaches replay, hits conflict detection, and becomes a pending resolution
    "
  `);

  expect(
    storeResolutionHook.result.current.map(summarizeDetailedConflictResolution),
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
      storeName: 'document-3'
      storeType: 'document'
      updatedAt: 1735689600001
  `);
  expect(storeResolutionHook.result.current.map(summarizeResolution))
    .toMatchInlineSnapshot(`
      - input: 'value: 2'
        kind: 'conflict'
        on: 'document:document'
        op: 'updateValue'
        reason: 'server-changed'
    `);
  storeOfflineHook.unmount();
  storeResolutionHook.unmount();
});
