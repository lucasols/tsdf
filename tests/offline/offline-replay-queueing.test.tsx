import { sleep } from '@ls-stack/utils/sleep';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type {
  CollectionOfflineOperationDefinition,
  DocumentOfflineOperationDefinition,
  ListQueryOfflineOperationDefinition,
} from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import {
  FetchError,
  TEST_INITIAL_TIME,
  normalizeError,
} from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { withSuppressedActError } from '../utils/withSuppressedActError';
import {
  type CreateUserOperations,
  deleteItemInputSchema,
  getLocalStorageKeys,
  getOfflineQueueEntries,
  getOfflineQueueEntryData,
  getSortedQueueSummary,
  type PatchUserOperations,
  type UpdateValueConflictOperations,
  type UpdateValueOperations,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  classifyMutationOutage,
  classifyRetryableReplayFailure,
  collectionCreateInputSchema,
  collectionSchema,
  docConflictSchema,
  docMutationInputSchema,
  docSchema,
  listQueryQueryPayloadSchema,
  quickRecoveryProbe,
  summarizeResolution,
  waitForMicrotaskCondition,
} from './offlineTestShared';

function formatReplayState(
  doc: { data: { value: number } | null } | undefined,
  entity: { syncState: string; pendingMutations: number } | undefined,
) {
  return `value:${doc?.data?.value ?? 'null'} sync:${entity?.syncState ?? 'none'} pending:${entity?.pendingMutations ?? 0}`;
}

function createReplayFailure(message: string) {
  return new FetchError(message, { path: '/document', method: 'PATCH' });
}

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

test('collection offline create rejects queueing the same temp id twice', async () => {
  // Start offline before the store initializes so the first mutation-side
  // network refresh already sees offline mode without needing a browser event.
  network.setOffline();
  const resolveCreates: Array<(result: { id: string; name: string }) => void> =
    [];

  // Set up a collection store with an offline createUser operation that uses
  // temp entities — each create gets a temp ID until the server confirms the
  // real one via reconcileServerEntity.
  const env = createCollectionStoreTestEnv<
    { name: string },
    CreateUserOperations
  >(
    { 'users||1': { name: 'User 1' } },
    {
      getSessionKey: () => 'offline-temp-id-session',
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => 'offline-temp-id-session',
        offlineSession: { network: network.config },
      }),
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            createUser: {
              inputSchema: collectionCreateInputSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              tempEntity: {
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
                  resolveCreates.push((result) => {
                    void env.serverTable
                      .delayedSetItem(result.id, { name: result.name })
                      .then(() => {
                        resolve(result);
                      });
                  });
                }),
            },
          },
        },
      },
    },
  );

  // Queue the first create while offline so the temp entity becomes the durable
  // pending row that later replay will reconcile.
  const queued = await env.apiStore.performMutation(null, {
    mutation: async () => {
      const result = { id: 'users||ada', name: 'Ada' };
      await env.serverTable.delayedSetItem(result.id, { name: result.name });
      return result;
    },
    offline: { operation: 'createUser', input: { name: 'Ada' } },
  });

  // A second create for the same temp id is ambiguous: replay would try to
  // create the same optimistic entity twice. Reject it instead of stacking two
  // creates under one temp row.
  const duplicateQueued = await env.apiStore.performMutation(null, {
    mutation: async () => {
      const result = { id: 'users||ada-2', name: 'Ada' };
      await env.serverTable.delayedSetItem(result.id, { name: result.name });
      return result;
    },
    offline: { operation: 'createUser', input: { name: 'Ada' } },
  });

  expect(queued.ok).toBe(true);
  expect({
    error: duplicateQueued.ok ? null : duplicateQueued.error,
    ok: duplicateQueued.ok,
  }).toMatchInlineSnapshot(`
    error{Error}:
      message: 'Offline operation "createUser" cannot queue temp entity "temp:Ada" more than once while it is still pending'
      name: 'StoreMutationError'
      kind: 'error'
      code: 500
      id: 'fetch-error'
      cause:
        Error#:
          message: 'Offline operation "createUser" cannot queue temp entity "temp:Ada" more than once while it is still pending'
          name: 'Error'

    ok: '❌'
  `);

  // The failed duplicate attempt must not create extra offline metadata.
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: '"temp:Ada'
      entityKind: 'item'
      id: 'offline-temp-id-session:collection-1:"temp:Ada'
      kind: 'create'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'offline-temp-id-session'
      storeName: 'collection-1'
      storeType: 'collection'
      syncState: 'pending'
      tempId: 'temp:Ada'
      updatedAt: 1735689600000
  `);

  // Go online and replay the original create. Once the server confirms the
  // final id, the temp metadata should be cleaned up normally.
  act(() => {
    network.goOnline();
  });
  await waitForMicrotaskCondition(() => resolveCreates.length > 0);
  expect(resolveCreates).toHaveLength(1);
  resolveCreates[0]?.({ id: 'users||ada', name: 'Ada' });
  await flushAllTimers();

  // After the original create is confirmed, the temp-entity metadata is fully cleared.
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
});

test('document offline accumulation keeps a single persisted queue entry and replays only the merged input', async () => {
  network.setOffline();
  const sessionKey = 'offline-accumulation-session';
  const storeName = 'offline-accumulation-doc';
  // Track which inputs are actually replayed to prove only the merged value is sent.
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
    .mockImplementation(async ({ input, enqueuedAt }) => {
      expect(enqueuedAt).toBe(TEST_INITIAL_TIME);
      await env.serverMock.delayedSetData(input.value);
      return input;
    });
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
            accumulation: { mergeInput: ({ incomingInput }) => incomingInput },
            execute,
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

  // Queue two mutations for the same entity while offline. With accumulation,
  // the second mutation should merge into the first queue entry rather than
  // creating a separate one.
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

  await advanceTime(50);
  await env.apiStore.performMutation({
    optimisticUpdate: () => {
      env.apiStore.updateState((draft) => {
        draft.value = 3;
      });
    },
    mutation: async () => {
      await env.serverMock.delayedSetData(3);
      return 3;
    },
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  // The optimistic state should reflect the latest mutation.
  expect(env.store.state.data).toMatchInlineSnapshot(`
    value: 3
  `);
  // Only one entity should be tracked since both mutations were accumulated.
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: 'document'
      entityKind: 'document'
      id: 'offline-accumulation-session:offline-accumulation-doc:document'
      kind: 'update'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'offline-accumulation-session'
      storeName: 'offline-accumulation-doc'
      storeType: 'document'
      syncState: 'pending'
      updatedAt: 1735689600050
  `);
  // The persisted queue should have exactly one entry with the merged input
  // (value: 3), not separate entries for each mutation.
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
  `);

  // Go online and let the queue drain. Only the merged value should be replayed.
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  // Execute was called exactly once, with the merged input (value: 3, not 2).
  expect(execute.mock.calls.map(([ctx]) => ctx.input)).toMatchInlineSnapshot(`
    - value: 3
  `);
  // Queue and entities are fully cleared after successful replay.
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
});

test('collection offline accumulation keeps a single persisted queue entry and replays only the merged input', async () => {
  network.setOffline();
  const sessionKey = 'offline-accumulation-collection-session';
  const storeName = 'offline-accumulation-collection';

  type RenameCollectionAccumulationOperations = {
    renameUser: CollectionOfflineOperationDefinition<
      { value: { name: string } },
      string,
      { itemId: string; name: string },
      unknown
    >;
  };

  // Track the replayed payload so we can prove only the merged rename is sent.
  const execute = vi
    .fn<
      ({
        input,
        enqueuedAt,
      }: {
        input: { itemId: string; name: string };
        enqueuedAt: number;
      }) => Promise<{ value: { name: string } }>
    >()
    .mockImplementation(async ({ input, enqueuedAt }) => {
      expect(enqueuedAt).toBe(TEST_INITIAL_TIME);
      await env.serverTable.delayedUpdateItem(input.itemId, {
        name: input.name,
      });
      return { value: { name: input.name } };
    });

  const env = createCollectionStoreTestEnv<
    { name: string },
    RenameCollectionAccumulationOperations
  >(
    { 'users||1': { name: 'Ada' } },
    {
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
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            renameUser: {
              inputSchema: userPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              accumulation: {
                mergeInput: ({ incomingInput }) => incomingInput,
              },
              execute,
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateItemState(input.itemId, (draft) => {
                  draft.value.name = input.name;
                });
              },
            },
          },
        },
      },
    },
  );

  // Queue two offline renames for the same item. Accumulation should keep only
  // the latest input in one durable queue entry.
  await env.apiStore.performMutation('users||1', {
    optimisticUpdate: () => {
      env.apiStore.updateItemState('users||1', (draft) => {
        draft.value.name = 'Ada second';
      });
    },
    mutation: async () => {
      await env.serverTable.delayedUpdateItem('users||1', {
        name: 'Ada second',
      });
      return { value: { name: 'Ada second' } };
    },
    offline: {
      operation: 'renameUser',
      input: { itemId: 'users||1', name: 'Ada second' },
    },
  });

  await advanceTime(50);
  await env.apiStore.performMutation('users||1', {
    optimisticUpdate: () => {
      env.apiStore.updateItemState('users||1', (draft) => {
        draft.value.name = 'Ada third';
      });
    },
    mutation: async () => {
      await env.serverTable.delayedUpdateItem('users||1', {
        name: 'Ada third',
      });
      return { value: { name: 'Ada third' } };
    },
    offline: {
      operation: 'renameUser',
      input: { itemId: 'users||1', name: 'Ada third' },
    },
  });

  expect(pick(env.apiStore.getItemState('users||1'), ['data', 'status']))
    .toMatchInlineSnapshot(`
      data:
        value: { name: 'Ada third' }

      status: 'success'
    `);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: '"users||1'
      entityKind: 'item'
      id: 'offline-accumulation-collection-session:offline-accumulation-collection:"users||1'
      kind: 'update'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'offline-accumulation-collection-session'
      storeName: 'offline-accumulation-collection'
      storeType: 'collection'
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
          - entityKey: '"users||1'
            entityKind: 'item'
        input: { itemId: 'users||1', name: 'Ada third' }
        lastAttemptAt: null
        operation: 'renameUser'
        sessionKey: 'offline-accumulation-collection-session'
        storeName: 'offline-accumulation-collection'
        storeType: 'collection'
        syncState: 'pending'
        updatedAt: 1735689600050
  `);

  // Going back online should replay only the merged rename.
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(execute.mock.calls.map(([ctx]) => ctx.input)).toMatchInlineSnapshot(`
    - { itemId: 'users||1', name: 'Ada third' }
  `);
  expect(pick(env.apiStore.getItemState('users||1'), ['data', 'status']))
    .toMatchInlineSnapshot(`
      data:
        value: { name: 'Ada third' }

      status: 'success'
    `);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
});

test('list-query offline accumulation keeps a single persisted queue entry and replays only the merged input', async () => {
  network.setOffline();
  const sessionKey = 'offline-accumulation-list-query-session';
  const storeName = 'offline-accumulation-list-query';

  // Track which payload is replayed so the test proves the queue merged.
  const execute = vi
    .fn<
      ({
        input,
        enqueuedAt,
      }: {
        input: { itemId: string; name: string };
        enqueuedAt: number;
      }) => Promise<{ id: number; name: string }>
    >()
    .mockImplementation(async ({ input, enqueuedAt }) => {
      expect(enqueuedAt).toBe(TEST_INITIAL_TIME);
      await env.serverTable.delayedUpdateItem(input.itemId, {
        id: 1,
        name: input.name,
      });
      return { id: 1, name: input.name };
    });

  const env = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    PatchUserOperations
  >(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          operations: {
            patchUserName: {
              inputSchema: userPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              accumulation: {
                mergeInput: ({ incomingInput }) => incomingInput,
              },
              execute,
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

  const hook = renderHook(() =>
    env.apiStore.useListQuery(
      { tableId: 'users' },
      { itemSelector: (item) => item.name },
    ),
  );
  await Promise.resolve();

  // Queue two offline edits for the same row. The second one should merge into
  // the first queue entry rather than creating another persisted record.
  await act(async () => {
    await env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', (item) => ({
          ...item,
          name: 'Ada second',
        }));
      },
      mutation: async () => {
        await env.serverTable.delayedUpdateItem('users||1', {
          id: 1,
          name: 'Ada second',
        });
        return { id: 1, name: 'Ada second' };
      },
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada second' },
      },
    });
  });

  await advanceTime(50);
  await act(async () => {
    await env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', (item) => ({
          ...item,
          name: 'Ada third',
        }));
      },
      mutation: async () => {
        await env.serverTable.delayedUpdateItem('users||1', {
          id: 1,
          name: 'Ada third',
        });
        return { id: 1, name: 'Ada third' };
      },
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada third' },
      },
    });
  });

  expect(hook.result.current.items).toMatchInlineSnapshot(`
    ['Ada third']
  `);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: '"users||1'
      entityKind: 'item'
      id: 'offline-accumulation-list-query-session:offline-accumulation-list-query:"users||1'
      kind: 'update'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'offline-accumulation-list-query-session'
      storeName: 'offline-accumulation-list-query'
      storeType: 'listQuery'
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
          - entityKey: '"users||1'
            entityKind: 'item'
        input: { itemId: 'users||1', name: 'Ada third' }
        lastAttemptAt: null
        operation: 'patchUserName'
        sessionKey: 'offline-accumulation-list-query-session'
        storeName: 'offline-accumulation-list-query'
        storeType: 'listQuery'
        syncState: 'pending'
        updatedAt: 1735689600050
  `);

  // Replay should run once with the merged payload and then fully clear queue state.
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await flushAllTimers();

  expect(execute.mock.calls.map(([ctx]) => ctx.input)).toMatchInlineSnapshot(`
    - { itemId: 'users||1', name: 'Ada third' }
  `);
  expect(hook.result.current.items).toMatchInlineSnapshot(`
    ['Ada third']
  `);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  hook.unmount();
});

test('same-entity supersede keeps only the queued delete for a persisted collection item', async () => {
  network.setOffline();
  const sessionKey = 'offline-supersede-delete-session';
  const storeName = 'offline-supersede-delete-store';
  const patchExecute = vi.fn(
    async ({ input }: { input: { itemId: string; name: string } }) => {
      await env.serverTable.delayedUpdateItem(input.itemId, {
        name: input.name,
      });
      return { name: input.name };
    },
  );
  const deleteExecute = vi.fn(
    async ({ input: input_ }: { input: { itemId: string } }) => {
      await env.serverTable.delayedRemoveItem(input_.itemId);
      return undefined;
    },
  );

  type SupersedeCollectionOperations = {
    patchUserName: CollectionOfflineOperationDefinition<
      { value: { name: string } },
      string,
      { itemId: string; name: string },
      unknown
    >;
    deleteUser: CollectionOfflineOperationDefinition<
      { value: { name: string } },
      string,
      { itemId: string },
      unknown
    >;
  };

  const env = createCollectionStoreTestEnv<
    { name: string },
    SupersedeCollectionOperations
  >(
    { 'users||1': { name: 'Ada' } },
    {
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
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            patchUserName: {
              inputSchema: userPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: patchExecute,
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateItemState(input.itemId, (item) => ({
                  ...item,
                  name: input.name,
                }));
              },
            },
            deleteUser: {
              inputSchema: deleteItemInputSchema,
              kind: 'delete',
              getEntityRefs: ({ input }) => [input.itemId],
              supersedes: { scope: 'same-entity' },
              execute: deleteExecute,
              onSuccessExecute: ({ input }) => {
                env.apiStore.deleteItemState(input.itemId);
              },
            },
          },
        },
      },
    },
  );

  // Queue an edit first so the later delete can supersede it.
  await env.apiStore.performMutation('users||1', {
    optimisticUpdate: () => {
      env.apiStore.updateItemState('users||1', (item) => ({
        ...item,
        name: 'Ada renamed offline',
      }));
    },
    mutation: async () => {
      await env.serverTable.delayedUpdateItem('users||1', {
        name: 'Ada renamed offline',
      });
      return { name: 'Ada renamed offline' };
    },
    offline: {
      operation: 'patchUserName',
      input: { itemId: 'users||1', name: 'Ada renamed offline' },
    },
  });

  // Queue the delete for the same item. The older edit should be pruned.
  await env.apiStore.performMutation('users||1', {
    optimisticUpdate: () => {
      env.apiStore.deleteItemState('users||1');
    },
    mutation: async () => {
      await env.serverTable.delayedRemoveItem('users||1');
    },
    offline: { operation: 'deleteUser', input: { itemId: 'users||1' } },
  });

  // Only the delete remains in the queue — the earlier edit was pruned.
  expect(getSortedQueueSummary(sessionKey, storeName)).toMatchInlineSnapshot(`
    - input: { itemId: 'users||1' }
      operation: 'deleteUser'
  `);

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: '"users||1'
      entityKind: 'item'
      id: 'offline-supersede-delete-session:offline-supersede-delete-store:"users||1'
      kind: 'delete'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'offline-supersede-delete-session'
      storeName: 'offline-supersede-delete-store'
      storeType: 'collection'
      syncState: 'pending'
      updatedAt: 1735689600000
  `);

  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(patchExecute).not.toHaveBeenCalled();
  expect(deleteExecute.mock.calls.map(([ctx]) => ctx.input))
    .toMatchInlineSnapshot(`
      - itemId: 'users||1'
    `);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
});

test('same-entity supersede can prune only the latest-wins operation while keeping unrelated queued work', async () => {
  network.setOffline();
  const sessionKey = 'offline-selective-supersede-session';
  const storeName = 'offline-selective-supersede-store';
  const replayedOperations: Array<
    | { operation: 'setUserRole'; input: { itemId: string; role: string } }
    | { operation: 'setUserName'; input: { itemId: string; name: string } }
  > = [];
  const setUserNameExecute = vi.fn(
    async ({ input }: { input: { itemId: string; name: string } }) => {
      replayedOperations.push({ operation: 'setUserName', input });
      await env.serverTable.delayedUpdateItem(input.itemId, {
        name: input.name,
      });
      return { name: input.name };
    },
  );
  const setUserRoleExecute = vi.fn(
    async ({ input }: { input: { itemId: string; role: string } }) => {
      replayedOperations.push({ operation: 'setUserRole', input });
      await env.serverTable.delayedUpdateItem(input.itemId, {
        role: input.role,
      });
      return { role: input.role };
    },
  );
  const setUserNameInputSchema = rc_object({
    itemId: rc_string,
    name: rc_string,
  });
  const setUserRoleInputSchema = rc_object({
    itemId: rc_string,
    role: rc_string,
  });
  const collectionWithRoleSchema = rc_object({
    value: rc_object({ name: rc_string, role: rc_string }),
  });

  type SelectiveSupersedeCollectionOperations = {
    setUserName: CollectionOfflineOperationDefinition<
      { name: string; role: string },
      string,
      { itemId: string; name: string },
      unknown
    >;
    setUserRole: CollectionOfflineOperationDefinition<
      { name: string; role: string },
      string,
      { itemId: string; role: string },
      unknown
    >;
  };

  const env = createCollectionStoreTestEnv<
    { name: string; role: string },
    SelectiveSupersedeCollectionOperations
  >(
    { 'users||1': { name: 'Ada', role: 'reader' } },
    {
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
        schema: collectionWithRoleSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            setUserName: {
              inputSchema: setUserNameInputSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              supersedes: { scope: 'same-entity', operations: 'self' },
              execute: setUserNameExecute,
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateItemState(input.itemId, (item) => ({
                  ...item,
                  name: input.name,
                }));
              },
            },
            setUserRole: {
              inputSchema: setUserRoleInputSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: setUserRoleExecute,
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateItemState(input.itemId, (item) => ({
                  ...item,
                  role: input.role,
                }));
              },
            },
          },
        },
      },
    },
  );

  // Keep an unrelated queued change for the same entity so the test can prove
  // selective supersede does not wipe the whole queue entry chain.
  await env.apiStore.performMutation('users||1', {
    optimisticUpdate: () => {
      env.apiStore.updateItemState('users||1', (item) => ({
        ...item,
        role: 'admin',
      }));
    },
    mutation: async () => {
      await env.serverTable.delayedUpdateItem('users||1', { role: 'admin' });
      return { role: 'admin' };
    },
    offline: {
      operation: 'setUserRole',
      input: { itemId: 'users||1', role: 'admin' },
    },
  });

  await env.apiStore.performMutation('users||1', {
    optimisticUpdate: () => {
      env.apiStore.updateItemState('users||1', (item) => ({
        ...item,
        name: 'Ada first',
      }));
    },
    mutation: async () => {
      await env.serverTable.delayedUpdateItem('users||1', {
        name: 'Ada first',
      });
      return { name: 'Ada first' };
    },
    offline: {
      operation: 'setUserName',
      input: { itemId: 'users||1', name: 'Ada first' },
    },
  });

  // Queue a later name change; this should replace only the earlier name
  // update, not the unrelated role change.
  await advanceTime(50);
  await env.apiStore.performMutation('users||1', {
    optimisticUpdate: () => {
      env.apiStore.updateItemState('users||1', (item) => ({
        ...item,
        name: 'Ada latest',
      }));
    },
    mutation: async () => {
      await env.serverTable.delayedUpdateItem('users||1', {
        name: 'Ada latest',
      });
      return { name: 'Ada latest' };
    },
    offline: {
      operation: 'setUserName',
      input: { itemId: 'users||1', name: 'Ada latest' },
    },
  });

  // The role change is preserved (different operation), but only the latest
  // name change survives (self-supersede pruned the earlier one).
  expect(getSortedQueueSummary(sessionKey, storeName)).toMatchInlineSnapshot(`
    - input: { itemId: 'users||1', role: 'admin' }
      operation: 'setUserRole'
    - input: { itemId: 'users||1', name: 'Ada latest' }
      operation: 'setUserName'
  `);

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: '"users||1'
      entityKind: 'item'
      id: 'offline-selective-supersede-session:offline-selective-supersede-store:"users||1'
      kind: 'update'
      pendingMutations: 2
      requiresResolution: '❌'
      sessionKey: 'offline-selective-supersede-session'
      storeName: 'offline-selective-supersede-store'
      storeType: 'collection'
      syncState: 'pending'
      updatedAt: 1735689600050
  `);

  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(replayedOperations).toMatchInlineSnapshot(`
    - input: { itemId: 'users||1', role: 'admin' }
      operation: 'setUserRole'
    - input: { itemId: 'users||1', name: 'Ada latest' }
      operation: 'setUserName'
  `);
  expect(setUserRoleExecute).toHaveBeenCalledTimes(1);
  expect(setUserNameExecute).toHaveBeenCalledTimes(1);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
});

test('ambiguous replay failures are discarded when the server confirms the mutation was already applied', async () => {
  network.setOffline();
  let skipCheckEnqueuedAt: number | null = null;

  // The first execute throws to simulate an ambiguous failure — the mutation
  // may or may not have reached the server, so the entry moves to
  // needs-confirmation state.
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
      throw createReplayFailure(`dispatch failed after send ${input.value}`);
    });
  // shouldSkipSync returns true — confirming the mutation was already applied
  // on the server, so the entry should be discarded without re-sending.
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
    getSessionKey: () => 'needs-confirmation-session',
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'needs-confirmation-session',
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
            execute,
            onSuccessExecute: ({ input }) => {
              env.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
            },
            shouldSkipSync,
          },
        },
      },
    },
  });

  renderHook(() => {
    const doc = env.apiStore.useDocument();
    const entity = env.apiStore.useOfflineEntities()[0];
    env.trackUIChanges(formatReplayState(doc, entity));
  });

  // Queue a mutation while offline.
  await act(async () => {
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
  });

  // Go online — the first replay attempt fails, moving the entry to
  // needs-confirmation. After the retry interval, shouldSkipSync is called
  // and returns true, so the entry is removed without retrying execute.
  env.addTimelineComments('beforeNextAction', [
    'go online — replay fails ambiguously, then shouldSkipSync confirms it was already applied',
  ]);
  await withSuppressedActError(async () => {
    act(() => {
      network.goOnline();
    });
    await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);
    await advanceTime(5_000);
    await flushAllTimers();
  });

  // Execute was only called once (the failed attempt); shouldSkipSync
  // confirmed the mutation was already applied, so no further retries.
  expect(execute).toHaveBeenCalledTimes(1);
  expect(shouldSkipSync).toHaveBeenCalledTimes(1);
  expect(skipCheckEnqueuedAt).toBe(TEST_INITIAL_TIME);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                                          |
    0     | "value:1 sync:none pending:0"               | ui-initialized
    .     | "value:2 sync:none pending:0"               | ui-changed
    .     | "value:2 sync:pending pending:1"            | ui-changed
    .     | "value:2 sync:pending pending:1"            | offline:updateValue queued
    .     | "value:2 sync:pending pending:1"            | -- go online — replay fails ambiguously, then shouldSkipSync confirms it was already applied
    .     | "value:2 sync:syncing pending:1"            | ui-changed
    .     | "value:2 sync:syncing pending:1"            | offline:updateValue replay-started
    .     | "value:2 sync:needs-confirmation pending:1" | ui-changed
    10ms  | "value:2 sync:needs-confirmation pending:1" | 🔴 >fetch-started
    810ms | "value:2 sync:needs-confirmation pending:1" | 🔴 <fetch-finished (value: 1)
    5s    | "value:2 sync:syncing pending:1"            | ui-changed
    .     | "value:1 sync:none pending:0"               | ui-changed
    5.01s | "value:1 sync:none pending:0"               | 🟠 >fetch-started
    5.81s | "value:1 sync:none pending:0"               | 🟠 <fetch-finished (value: 1)
    "
  `);
});

test('ambiguous replay failures are retried when the server confirms the mutation was not applied', async () => {
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
      throw createReplayFailure(`dispatch failed after send ${input.value}`);
    })
    .mockImplementation(async ({ input }) => {
      await env.serverMock.delayedSetData(input.value, { durationMs: 0 });
      return { value: env.serverMock.current };
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
      return Promise.resolve(false);
    });

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'needs-confirmation-no-outage-session',
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'needs-confirmation-no-outage-session',
      offlineSession: {
        network: network.config,
        classifyRetryableFailure: (error, ctx) =>
          classifyRetryableReplayFailure(error, ctx.phase),
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
            onSuccessExecute: ({ input }) => {
              env.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
            },
            shouldSkipSync,
          },
        },
      },
    },
  });

  renderHook(() => {
    const doc = env.apiStore.useDocument();
    const entity = env.apiStore.useOfflineEntities()[0];
    env.trackUIChanges(formatReplayState(doc, entity));
  });

  let mutationResult!: Awaited<ReturnType<typeof env.apiStore.performMutation>>;
  await act(async () => {
    mutationResult = await env.apiStore.performMutation({
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
  });
  expect(mutationResult.ok).toBe(true);

  await advanceTime(100);

  // The first online replay should settle into syncing before the retry
  // window has a chance to decide whether the queued mutation should continue.
  env.addTimelineComments('beforeNextAction', [
    'bring the session online and wait for the first replay attempt to settle into syncing',
  ]);
  act(() => {
    network.goOnline();
  });
  await withSuppressedActError(async () => {
    await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);
  });

  expect(execute).toHaveBeenCalledTimes(1);
  expect(shouldSkipSync).toHaveBeenCalledTimes(0);

  // After the retry window opens, the same queued mutation should replay
  // again instead of staying paused forever.
  env.addTimelineComments('beforeNextAction', [
    'advance the retry window so shouldSkipSync can allow the queued mutation to replay again',
  ]);
  await advanceTime(5_000);
  await flushAllTimers();

  expect(shouldSkipSync).toHaveBeenCalledTimes(1);
  expect(skipCheckEnqueuedAt).toBe(TEST_INITIAL_TIME);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui                                          |
    0      | "value:1 sync:none pending:0"               | ui-initialized
    .      | "value:2 sync:none pending:0"               | ui-changed
    .      | "value:2 sync:pending pending:1"            | ui-changed
    .      | "value:2 sync:pending pending:1"            | offline:updateValue queued
    100ms  | "value:2 sync:pending pending:1"            | -- bring the session online and wait for the first replay attempt to settle into syncing
    .      | "value:2 sync:syncing pending:1"            | ui-changed
    .      | "value:2 sync:syncing pending:1"            | offline:updateValue replay-started
    .      | "value:2 sync:syncing pending:1"            | -- advance the retry window so shouldSkipSync can allow the queued mutation to replay again
    .      | "value:2 sync:needs-confirmation pending:1" | ui-changed
    5.1s   | "value:2 sync:syncing pending:1"            | ui-changed
    .      | "value:2 sync:syncing pending:1"            | offline:updateValue replay-started
    5.101s | "value:2 sync:syncing pending:1"            | server-data-changed (value: 2)
    .      | "value:2 sync:syncing pending:1"            | offline:updateValue replay-finished
    .      | "value:2 sync:none pending:0"               | ui-changed
    5.111s | "value:2 sync:none pending:0"               | 🔴 >fetch-started
    5.911s | "value:2 sync:none pending:0"               | 🔴 <fetch-finished (value: 2)
    "
  `);
});

test('ambiguous replay failures require manual resolution by default instead of auto-retrying', async () => {
  network.setOffline();
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockRejectedValue(createReplayFailure('replay failed'));

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: 'retry-default-safe-store',
    getSessionKey: () => 'retry-default-safe-session',
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'retry-default-safe-session',
      offlineSession: {
        network: network.config,
        replayRetry: { intervalMs: 1 },
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

  await act(async () => {
    await env.apiStore.performMutation({
      mutation: async () => {
        await env.serverMock.delayedSetData(2);
        return 2;
      },
      offline: { operation: 'updateValue', input: { value: 2 } },
    });
  });

  act(() => {
    network.goOnline();
  });
  await advanceTime(1);
  await flushAllTimers();

  // The failed replay is not auto-sent again unless the session explicitly
  // opts into replay retries for that failure shape.
  expect(execute).toHaveBeenCalledTimes(1);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600001
      entityKey: 'document'
      entityKind: 'document'
      id: 'retry-default-safe-session:retry-default-safe-store:document'
      kind: 'update'
      pendingMutations: 0
      requiresResolution: '✅'
      sessionKey: 'retry-default-safe-session'
      storeName: 'retry-default-safe-store'
      storeType: 'document'
      syncState: 'resolution-required'
      updatedAt: 1735689600001
  `);
  expect(env.apiStore.getOfflineResolutions().map(summarizeResolution))
    .toMatchInlineSnapshot(`
      - error: 'replay failed'
        input: 'value: 2'
        kind: 'retry-exhausted'
        on: 'document:document'
        op: 'updateValue'
    `);
});

test('healthy replay failures are retried 3 times and then move into the resolution queue', async () => {
  network.setOffline();
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockRejectedValue(createReplayFailure('replay failed'));

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'retry-exhaustion-session',
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'retry-exhaustion-session',
      offlineSession: {
        network: network.config,
        classifyRetryableFailure: (error, ctx) =>
          classifyRetryableReplayFailure(error, ctx.phase),
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

  renderHook(() => {
    const doc = env.apiStore.useDocument();
    const entity = env.apiStore.useOfflineEntities()[0];
    env.trackUIChanges(formatReplayState(doc, entity));
  });

  await act(async () => {
    await env.apiStore.performMutation({
      mutation: async () => {
        await env.serverMock.delayedSetData(2);
        return 2;
      },
      offline: { operation: 'updateValue', input: { value: 2 } },
    });
  });

  // Bring the browser back online so the first replay failure can start the
  // healthy retry budget for this queued mutation.
  env.addTimelineComments('beforeNextAction', [
    'bring the browser back online so the first replay failure starts the healthy retry budget',
  ]);
  act(() => {
    network.goOnline();
  });
  await withSuppressedActError(async () => {
    await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);
  });

  // Keep the session online long enough to spend the remaining retry budget.
  env.addTimelineComments('beforeNextAction', [
    'keep the session online long enough to spend the remaining healthy retry budget',
  ]);
  for (const attempt of [2, 3]) {
    await advanceTime(5_000);
    await withSuppressedActError(async () => {
      await waitForMicrotaskCondition(
        () => execute.mock.calls.length === attempt,
      );
    });
  }
  await flushAllTimers();

  expect(execute).toHaveBeenCalledTimes(3);

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689610000
      entityKey: 'document'
      entityKind: 'document'
      id: 'retry-exhaustion-session:document-4:document'
      kind: 'update'
      pendingMutations: 0
      requiresResolution: '✅'
      sessionKey: 'retry-exhaustion-session'
      storeName: 'document-4'
      storeType: 'document'
      syncState: 'resolution-required'
      updatedAt: 1735689610000
  `);

  expect(env.apiStore.getOfflineResolutions().map(summarizeResolution))
    .toMatchInlineSnapshot(`
      - error: 'replay failed'
        input: 'value: 2'
        kind: 'retry-exhausted'
        on: 'document:document'
        op: 'updateValue'
    `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                                           |
    0     | "value:1 sync:none pending:0"                | ui-initialized
    .     | "value:1 sync:pending pending:1"             | ui-changed
    .     | "value:1 sync:pending pending:1"             | offline:updateValue queued
    .     | "value:1 sync:pending pending:1"             | -- bring the browser back online so the first replay failure starts the healthy retry budget
    .     | "value:1 sync:syncing pending:1"             | ui-changed
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .     | "value:1 sync:syncing pending:1"             | -- keep the session online long enough to spend the remaining healthy retry budget
    .     | "value:1 sync:needs-confirmation pending:1"  | ui-changed
    10ms  | "value:1 sync:needs-confirmation pending:1"  | 🔴 >fetch-started
    810ms | "value:1 sync:needs-confirmation pending:1"  | 🔴 <fetch-finished (value: 1)
    5s    | "value:1 sync:syncing pending:1"             | ui-changed
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .     | "value:1 sync:needs-confirmation pending:1"  | ui-changed
    10s   | "value:1 sync:syncing pending:1"             | ui-changed
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue resolution-required
    .     | "value:1 sync:resolution-required pending:0" | ui-changed
    "
  `);
});

test('retry-exhausted resolutions can retry or discard queued work', async () => {
  network.setOffline();
  // Execute call schedule:
  //   calls 1–3: fail (exhaust first retry budget → resolution)
  //   call 4: succeed (after user resolves with "retry")
  //   calls 5–7: fail (exhaust second retry budget → another resolution)
  let replayAttempt = 0;
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockImplementation(async ({ input }) => {
      replayAttempt += 1;

      if (replayAttempt === 4) {
        await env.serverMock.delayedSetData(input.value, { durationMs: 0 });
        return { value: env.serverMock.current };
      }

      throw createReplayFailure('replay failed');
    });

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'retry-resolution-actions-session',
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'retry-resolution-actions-session',
      offlineSession: {
        network: network.config,
        classifyRetryableFailure: (error, ctx) =>
          classifyRetryableReplayFailure(error, ctx.phase),
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

  renderHook(() => {
    const doc = env.apiStore.useDocument();
    const entity = env.apiStore.useOfflineEntities()[0];
    env.trackUIChanges(formatReplayState(doc, entity));
  });

  const queueOfflineMutation = async () => {
    await act(async () => {
      await env.apiStore.performMutation({
        mutation: async () => {
          await env.serverMock.delayedSetData(2);
          return 2;
        },
        offline: { operation: 'updateValue', input: { value: 2 } },
      });
    });
  };

  // --- Phase 1: Exhaust the retry budget to produce a resolution ---
  await queueOfflineMutation();

  // Go online and let all 3 retry attempts fail.
  env.addTimelineComments('beforeNextAction', [
    'go online — exhaust the 3-attempt retry budget',
  ]);
  act(() => {
    network.goOnline();
  });
  await withSuppressedActError(async () => {
    await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);
  });
  for (const attempt of [2, 3]) {
    await advanceTime(5_000);
    await withSuppressedActError(async () => {
      await waitForMicrotaskCondition(
        () => execute.mock.calls.length === attempt,
      );
    });
  }
  await flushAllTimers();

  // The mutation should now be in the resolution queue as retry-exhausted.
  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution || resolution.kind !== 'retry-exhausted') {
    throw new Error('Expected a retry-exhausted resolution');
  }

  expect(summarizeResolution(resolution)).toMatchInlineSnapshot(`
    error: 'replay failed'
    input: 'value: 2'
    kind: 'retry-exhausted'
    on: 'document:document'
    op: 'updateValue'
  `);

  // Retry-exhausted entries have no conflict data, so parsing returns a
  // not-conflict error rather than a typed conflict payload.
  const parseRetryResult =
    env.apiStore.parseOfflineResolutionConflict(resolution);
  expect(parseRetryResult.ok).toBe(false);
  if (!parseRetryResult.ok) {
    expect({
      code: parseRetryResult.error.code,
      kind: parseRetryResult.error.kind,
      name: parseRetryResult.error.name,
      operation: parseRetryResult.error.operation,
    }).toMatchInlineSnapshot(`
      code: 'not-conflict'
      kind: 'retry-exhausted'
      name: 'OfflineResolutionConflictParseError'
      operation: 'updateValue'
    `);
  }

  // --- Phase 2: Resolve with "retry" — should re-enqueue and succeed ---
  env.addTimelineComments('beforeNextAction', [
    'user resolves with "retry" — entry re-enqueued, 4th execute call succeeds',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(resolution.id, 'updateValue', {
      action: 'retry',
    });
  });
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

  // The 4th execute call succeeds, clearing the queue.
  await withSuppressedActError(async () => {
    await waitForMicrotaskCondition(() => execute.mock.calls.length === 4);
  });
  await flushAllTimers();

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);

  // --- Phase 3: Queue another mutation and exhaust retries again to test discard ---
  env.addTimelineComments('beforeNextAction', [
    'go offline, queue another mutation, come back online — exhaust retries again',
  ]);
  await act(async () => {
    network.goOffline();
    await Promise.resolve();
  });
  await queueOfflineMutation();
  act(() => {
    network.goOnline();
  });
  await withSuppressedActError(async () => {
    await waitForMicrotaskCondition(() => execute.mock.calls.length === 5);
  });
  // All further execute calls fail — exhaust the retry budget again.
  for (const attempt of [6, 7]) {
    await advanceTime(5_000);
    await withSuppressedActError(async () => {
      await waitForMicrotaskCondition(
        () => execute.mock.calls.length === attempt,
      );
    });
  }
  await flushAllTimers();

  // Another retry-exhausted resolution should be in the queue.
  const [discardResolution] = env.apiStore.getOfflineResolutions();
  if (!discardResolution || discardResolution.kind !== 'retry-exhausted') {
    throw new Error('Expected a retry-exhausted discard resolution');
  }

  expect(summarizeResolution(discardResolution)).toMatchInlineSnapshot(`
    error: 'replay failed'
    input: 'value: 2'
    kind: 'retry-exhausted'
    on: 'document:document'
    op: 'updateValue'
  `);

  const parseDiscardResult =
    env.apiStore.parseOfflineResolutionConflict(discardResolution);
  expect(parseDiscardResult.ok).toBe(false);
  if (!parseDiscardResult.ok) {
    expect({
      code: parseDiscardResult.error.code,
      kind: parseDiscardResult.error.kind,
      name: parseDiscardResult.error.name,
      operation: parseDiscardResult.error.operation,
    }).toMatchInlineSnapshot(`
      code: 'not-conflict'
      kind: 'retry-exhausted'
      name: 'OfflineResolutionConflictParseError'
      operation: 'updateValue'
    `);
  }

  // --- Phase 4: Resolve with "discard" — should permanently remove the entry ---
  env.addTimelineComments('beforeNextAction', [
    'user resolves with "discard" — entry permanently removed',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      discardResolution.id,
      'updateValue',
      { action: 'discard' },
    );
  });
  // Let the refetch that follows the discard finish.
  await flushAllTimers();

  // Both resolutions and entities should be empty after discard.
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);

  // Full timeline showing the retry → resolve → retry → discard lifecycle.
  // The discard ends with a refetch (🟡), so the document shows the server
  // value again instead of what the discarded change left behind.
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui                                           |
    0      | "value:1 sync:none pending:0"                | ui-initialized
    .      | "value:1 sync:pending pending:1"             | ui-changed
    .      | "value:1 sync:pending pending:1"             | offline:updateValue queued
    .      | "value:1 sync:pending pending:1"             | -- go online — exhaust the 3-attempt retry budget
    .      | "value:1 sync:syncing pending:1"             | ui-changed
    .      | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .      | "value:1 sync:needs-confirmation pending:1"  | ui-changed
    10ms   | "value:1 sync:needs-confirmation pending:1"  | 🔴 >fetch-started
    810ms  | "value:1 sync:needs-confirmation pending:1"  | 🔴 <fetch-finished (value: 1)
    5s     | "value:1 sync:syncing pending:1"             | ui-changed
    .      | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .      | "value:1 sync:needs-confirmation pending:1"  | ui-changed
    10s    | "value:1 sync:syncing pending:1"             | ui-changed
    .      | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .      | "value:1 sync:syncing pending:1"             | offline:updateValue resolution-required
    .      | "value:1 sync:resolution-required pending:0" | ui-changed
    .      | "value:1 sync:resolution-required pending:0" | -- user resolves with "retry" — entry re-enqueued, 4th execute call succeeds
    .      | "value:1 sync:pending pending:1"             | ui-changed
    .      | "value:1 sync:syncing pending:1"             | ui-changed
    .      | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .      | "value:1 sync:syncing pending:1"             | server-data-changed (value: 2)
    .      | "value:1 sync:syncing pending:1"             | offline:updateValue replay-finished
    .      | "value:2 sync:none pending:0"                | ui-changed
    10.01s | "value:2 sync:none pending:0"                | 🟠 >fetch-started
    10.81s | "value:2 sync:none pending:0"                | 🟠 <fetch-finished (value: 2)
    11.81s | "value:2 sync:none pending:0"                | -- go offline, queue another mutation, come back online — exhaust retries again
    .      | "value:2 sync:pending pending:1"             | ui-changed
    .      | "value:2 sync:pending pending:1"             | offline:updateValue queued
    .      | "value:2 sync:syncing pending:1"             | ui-changed
    .      | "value:2 sync:syncing pending:1"             | offline:updateValue replay-started
    .      | "value:2 sync:needs-confirmation pending:1"  | ui-changed
    16.81s | "value:2 sync:syncing pending:1"             | ui-changed
    .      | "value:2 sync:syncing pending:1"             | offline:updateValue replay-started
    .      | "value:2 sync:needs-confirmation pending:1"  | ui-changed
    21.81s | "value:2 sync:syncing pending:1"             | ui-changed
    .      | "value:2 sync:syncing pending:1"             | offline:updateValue replay-started
    .      | "value:2 sync:syncing pending:1"             | offline:updateValue resolution-required
    .      | "value:2 sync:resolution-required pending:0" | ui-changed
    .      | "value:2 sync:resolution-required pending:0" | -- user resolves with "discard" — entry permanently removed
    .      | "value:2 sync:none pending:0"                | ui-changed
    21.82s | "value:2 sync:none pending:0"                | 🟡 >fetch-started
    22.62s | "value:2 sync:none pending:0"                | 🟡 <fetch-finished (value: 2)
    "
  `);
});

test('outage-classified replay failures do not count toward retry exhaustion', async () => {
  network.setOffline();
  // First attempt fails with an outage error (should not count toward the retry
  // budget), second attempt fails with a healthy error (should count), third
  // attempt succeeds.
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockImplementationOnce(() => {
      throw createReplayFailure('outage');
    })
    .mockImplementationOnce(() => {
      throw createReplayFailure('healthy failure');
    })
    .mockImplementation(async ({ input }) => {
      await env.serverMock.delayedSetData(input.value, { durationMs: 0 });
      return { value: env.serverMock.current };
    });
  const recoveryCheck = vi
    .fn<({ sessionKey }: { sessionKey: string }) => boolean>()
    .mockReturnValue(true);

  // Configure a low retry budget (maxFailures: 2) so the test can verify that
  // the outage failure doesn't consume from it while the healthy failure does.
  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'retry-outage-session',
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'retry-outage-session',
      offlineSession: {
        network: { enabled: true },
        classifyFailure: (error, ctx) =>
          ctx.phase === 'sync' &&
          error instanceof Error &&
          error.message === 'outage'
            ? 'outage'
            : 'ignore',
        classifyRetryableFailure: (error, ctx) =>
          classifyRetryableReplayFailure(error, ctx.phase),
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
        replayRetry: { maxFailures: 2 },
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

  // Queue a mutation while offline.
  await env.apiStore.performMutation({
    mutation: async () => {
      await env.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  // Go online and let two replay attempts run: the first triggers an outage
  // (which fires a recovery probe), the second is a healthy failure.
  act(() => {
    network.goOnline();
  });
  await advanceTime(60);
  await waitForMicrotaskCondition(() => execute.mock.calls.length === 2);

  // The outage triggered one recovery check. Since maxFailures is 2 and only
  // one healthy failure has occurred, the entry should NOT be in the resolution
  // queue — it should still be retryable.
  expect(recoveryCheck).toHaveBeenCalledTimes(1);
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

  // The entry remains in needs-confirmation rather than being exhausted,
  // proving the outage failure did not count toward the retry budget.
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: 'document'
      entityKind: 'document'
      id: 'retry-outage-session:document-6:document'
      kind: 'update'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'retry-outage-session'
      storeName: 'document-6'
      storeType: 'document'
      syncState: 'needs-confirmation'
      updatedAt: 1735689600050
  `);
});

test('going offline again resets the healthy replay failure budget', async () => {
  network.setOffline();
  let countedFailures = 0;
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockImplementation(() => {
      countedFailures += 1;
      throw createReplayFailure(`healthy failure ${countedFailures}`);
    });

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'retry-budget-reset-session',
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'retry-budget-reset-session',
      offlineSession: {
        network: network.config,
        classifyRetryableFailure: (error, ctx) =>
          classifyRetryableReplayFailure(error, ctx.phase),
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

  renderHook(() => {
    const doc = env.apiStore.useDocument();
    const entity = env.apiStore.useOfflineEntities()[0];
    env.trackUIChanges(formatReplayState(doc, entity));
  });

  await act(async () => {
    await env.apiStore.performMutation({
      mutation: async () => {
        await env.serverMock.delayedSetData(2);
        return 2;
      },
      offline: { operation: 'updateValue', input: { value: 2 } },
    });
  });

  // Start replaying while online, but stop before the queued mutation has
  // exhausted its healthy retry budget.
  env.addTimelineComments('beforeNextAction', [
    'start replaying online, but stop before the queued mutation exhausts its healthy retry budget',
  ]);
  act(() => {
    network.goOnline();
  });
  await withSuppressedActError(async () => {
    await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);
  });

  env.addTimelineComments('beforeNextAction', [
    'keep retrying until the mutation has spent only part of its healthy retry budget',
  ]);
  for (const attempt of [2]) {
    await advanceTime(5_000);
    await withSuppressedActError(async () => {
      await waitForMicrotaskCondition(
        () => execute.mock.calls.length === attempt,
      );
    });
  }

  // Going offline while the queued mutation is paused in needs-confirmation
  // should let the next online transition restart the healthy retry budget.
  env.addTimelineComments('beforeNextAction', [
    'go offline again while the queued mutation is paused in needs-confirmation',
  ]);
  await act(async () => {
    network.goOffline();
    await Promise.resolve();
  });

  env.addTimelineComments('beforeNextAction', [
    'come back online and verify the paused mutation gets a fresh healthy retry budget',
  ]);
  act(() => {
    network.goOnline();
  });
  await withSuppressedActError(async () => {
    await waitForMicrotaskCondition(() => execute.mock.calls.length === 3);
  });

  env.addTimelineComments('beforeNextAction', [
    'spend the fresh retry budget; only after these new failures should the mutation require resolution',
  ]);
  for (const attempt of [4, 5]) {
    await advanceTime(5_000);
    await withSuppressedActError(async () => {
      await waitForMicrotaskCondition(
        () => execute.mock.calls.length === attempt,
      );
    });
  }
  await flushAllTimers();

  expect(env.apiStore.getOfflineResolutions().map(summarizeResolution))
    .toMatchInlineSnapshot(`
      - error: 'healthy failure 5'
        input: 'value: 2'
        kind: 'retry-exhausted'
        on: 'document:document'
        op: 'updateValue'
    `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                                           |
    0     | "value:1 sync:none pending:0"                | ui-initialized
    .     | "value:1 sync:pending pending:1"             | ui-changed
    .     | "value:1 sync:pending pending:1"             | offline:updateValue queued
    .     | "value:1 sync:pending pending:1"             | -- start replaying online, but stop before the queued mutation exhausts its healthy retry budget
    .     | "value:1 sync:syncing pending:1"             | ui-changed
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .     | "value:1 sync:syncing pending:1"             | -- keep retrying until the mutation has spent only part of its healthy retry budget
    .     | "value:1 sync:needs-confirmation pending:1"  | ui-changed
    10ms  | "value:1 sync:needs-confirmation pending:1"  | 🔴 >fetch-started
    810ms | "value:1 sync:needs-confirmation pending:1"  | 🔴 <fetch-finished (value: 1)
    5s    | "value:1 sync:syncing pending:1"             | ui-changed
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .     | "value:1 sync:needs-confirmation pending:1"  | ui-changed
    .     | "value:1 sync:needs-confirmation pending:1"  | -- go offline again while the queued mutation is paused in needs-confirmation
    .     | "value:1 sync:needs-confirmation pending:1"  | -- come back online and verify the paused mutation gets a fresh healthy retry budget
    .     | "value:1 sync:syncing pending:1"             | ui-changed
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .     | "value:1 sync:syncing pending:1"             | -- spend the fresh retry budget; only after these new failures should the mutation require resolution
    .     | "value:1 sync:needs-confirmation pending:1"  | ui-changed
    10s   | "value:1 sync:syncing pending:1"             | ui-changed
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .     | "value:1 sync:needs-confirmation pending:1"  | ui-changed
    15s   | "value:1 sync:syncing pending:1"             | ui-changed
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue resolution-required
    .     | "value:1 sync:resolution-required pending:0" | ui-changed
    "
  `);
});

test('new mutations queue separately instead of merging into entries that may have already been applied', async () => {
  network.setOffline();
  // First attempt fails (simulating ambiguous send), second attempt succeeds.
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockImplementationOnce(() => {
      throw createReplayFailure('dispatch failed after send');
    })
    .mockImplementation(async ({ input }) => {
      await env.serverMock.delayedSetData(input.value, { durationMs: 0 });
      return { value: env.serverMock.current };
    });

  // Use accumulation so we can verify that new mutations do NOT merge into an
  // entry that may have already been applied on the server.
  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'offline-needs-confirmation-accumulation-session',
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'offline-needs-confirmation-accumulation-session',
      offlineSession: { network: { enabled: true } },
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
            accumulation: { mergeInput: ({ incomingInput }) => incomingInput },
            execute,
            onSuccessExecute: ({ input }) => {
              env.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
            },
            shouldSkipSync: () => false,
          },
        },
      },
    },
  });
  await Promise.resolve();

  // Queue a mutation while offline.
  await env.apiStore.performMutation({
    mutation: async () => {
      await env.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  // Go online — execute fails, moving the entry to needs-confirmation.
  act(() => {
    network.goOnline();
  });
  await advanceTime(1);
  await Promise.resolve();

  // The entry is now in needs-confirmation — it may have already been applied
  // on the server, so it's unsafe to merge new input into it.
  expect(
    env.apiStore
      .getOfflineEntities()
      .map((e) => pick(e, ['syncState', 'pendingMutations'])),
  ).toMatchInlineSnapshot(
    `- { pendingMutations: 1, syncState: 'needs-confirmation' }`,
  );

  // Go offline again and queue a second mutation.
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  await env.apiStore.performMutation({
    mutation: async () => {
      await env.serverMock.delayedSetData(3);
      return 3;
    },
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  // The second mutation creates a separate pending entry (pendingMutations: 2)
  // rather than merging into the needs-confirmation entry — because the first
  // entry may have already been applied and merging could corrupt the data.
  expect(
    env.apiStore
      .getOfflineEntities()
      .map((e) => pick(e, ['syncState', 'pendingMutations'])),
  ).toMatchInlineSnapshot(
    `- { pendingMutations: 2, syncState: 'needs-confirmation' }`,
  );
});

test('supersede does not discard entries that may have already been applied on the server', async () => {
  network.setOffline();
  const sessionKey = 'offline-needs-confirmation-supersede-session';
  const storeName = 'offline-needs-confirmation-supersede-store';
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockImplementationOnce(() => {
      throw createReplayFailure('dispatch failed after send');
    })
    .mockImplementation(async ({ input }) => {
      await env.serverMock.delayedSetData(input.value, { durationMs: 0 });
      return { value: env.serverMock.current };
    });

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
            supersedes: { scope: 'same-entity' },
            execute,
            onSuccessExecute: ({ input }) => {
              env.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
            },
            shouldSkipSync: () => false,
          },
        },
      },
    },
  });

  // Let the first queued mutation reach needs-confirmation before adding a new one.
  await env.apiStore.performMutation({
    mutation: async () => {
      await env.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  act(() => {
    network.goOnline();
  });
  await advanceTime(1);
  await Promise.resolve();

  // Verify the first entry reached needs-confirmation before proceeding.
  expect(
    env.apiStore
      .getOfflineEntities()
      .map((e) => pick(e, ['syncState', 'pendingMutations'])),
  ).toMatchInlineSnapshot(
    `- { pendingMutations: 1, syncState: 'needs-confirmation' }`,
  );

  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  // The new superseding entry should not remove the already-attempted one.
  await env.apiStore.performMutation({
    mutation: async () => {
      await env.serverMock.delayedSetData(3);
      return 3;
    },
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  // Both queue entries should be preserved: the needs-confirmation one and
  // the new pending one — the supersede did NOT discard the already-attempted entry.
  expect(
    getSortedQueueSummary(sessionKey, storeName, [
      'input',
      'operation',
      'syncState',
    ]),
  ).toMatchInlineSnapshot(`
    - input: { value: 2 }
      operation: 'updateValue'
      syncState: 'needs-confirmation'
    - input: { value: 3 }
      operation: 'updateValue'
      syncState: 'pending'
  `);

  // The entity should now have 2 pending mutations: the original
  // needs-confirmation entry was preserved (not superseded).
  expect(
    env.apiStore
      .getOfflineEntities()
      .map((e) => pick(e, ['syncState', 'pendingMutations'])),
  ).toMatchInlineSnapshot(
    `- { pendingMutations: 2, syncState: 'needs-confirmation' }`,
  );
});

test('ambiguous entries are periodically re-checked for server confirmation while online', async () => {
  network.setOffline();
  let skipCheckEnqueuedAt: number | null = null;
  // First attempt throws (ambiguous failure), no further execute calls expected
  // since shouldSkipSync keeps returning true to discard the entry.
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
      throw createReplayFailure(`dispatch failed after send ${input.value}`);
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
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'online-needs-confirmation-retry-session',
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
            execute,
            onSuccessExecute: ({ input }) => {
              env.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
            },
            shouldSkipSync,
          },
        },
      },
    },
  });

  renderHook(() => {
    const doc = env.apiStore.useDocument();
    const entity = env.apiStore.useOfflineEntities()[0];
    env.trackUIChanges(formatReplayState(doc, entity));
  });

  // Queue a mutation while offline.
  await act(async () => {
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
  });

  // Go online — execute fails, entry moves to needs-confirmation.
  // shouldSkipSync is NOT called immediately — only after the retry interval.
  env.addTimelineComments('beforeNextAction', [
    'go online — execute fails ambiguously, entry moves to needs-confirmation',
  ]);
  act(() => {
    network.goOnline();
  });
  await withSuppressedActError(async () => {
    await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);
    await waitForMicrotaskCondition(
      () =>
        env.apiStore.getOfflineEntities()[0]?.syncState ===
        'needs-confirmation',
    );
  });

  expect(execute).toHaveBeenCalledTimes(1);
  expect(shouldSkipSync).toHaveBeenCalledTimes(0);

  // After the retry interval elapses, shouldSkipSync is polled again. It
  // returns true, so the entry is discarded (confirmed already applied).
  env.addTimelineComments('beforeNextAction', [
    'retry interval elapses — shouldSkipSync confirms mutation was applied, entry cleared',
  ]);
  await advanceTime(5_000);
  await flushAllTimers();

  expect(shouldSkipSync).toHaveBeenCalledTimes(1);
  expect(skipCheckEnqueuedAt).toBe(TEST_INITIAL_TIME);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                                          |
    0     | "value:1 sync:none pending:0"               | ui-initialized
    .     | "value:2 sync:none pending:0"               | ui-changed
    .     | "value:2 sync:pending pending:1"            | ui-changed
    .     | "value:2 sync:pending pending:1"            | offline:updateValue queued
    .     | "value:2 sync:pending pending:1"            | -- go online — execute fails ambiguously, entry moves to needs-confirmation
    .     | "value:2 sync:syncing pending:1"            | ui-changed
    .     | "value:2 sync:syncing pending:1"            | offline:updateValue replay-started
    .     | "value:2 sync:needs-confirmation pending:1" | ui-changed
    10ms  | "value:2 sync:needs-confirmation pending:1" | -- retry interval elapses — shouldSkipSync confirms mutation was applied, entry cleared
    .     | "value:2 sync:needs-confirmation pending:1" | 🔴 >fetch-started
    810ms | "value:2 sync:needs-confirmation pending:1" | 🔴 <fetch-finished (value: 1)
    5s    | "value:2 sync:syncing pending:1"            | ui-changed
    .     | "value:1 sync:none pending:0"               | ui-changed
    5.01s | "value:1 sync:none pending:0"               | 🟠 >fetch-started
    5.81s | "value:1 sync:none pending:0"               | 🟠 <fetch-finished (value: 1)
    "
  `);
});

test('session switches do not leave replayed queue entries in the old namespace', async () => {
  network.setOffline();
  let sessionKey: string | false = 'replay-session-a';
  let resolveReplay: ((result: { value: number }) => void) | undefined;

  // Use a manually-resolved execute so we can switch the session key while
  // replay is in-flight and verify cleanup happens in the original namespace.
  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: 'replay-session-switch-doc',
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
            execute: () =>
              new Promise<{ value: number }>((resolve) => {
                resolveReplay = (result) => {
                  void env.serverMock.delayedSetData(result.value).then(() => {
                    resolve(result);
                  });
                };
              }),
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

  // Queue a mutation under session-a.
  await env.apiStore.performMutation({
    mutation: async () => {
      await env.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  // Verify the queue entry was persisted under session-a's namespace.
  expect(
    getLocalStorageKeys().filter((key) =>
      key.startsWith('tsdf.replay-session-a.replay-session-switch-doc.oq.'),
    ),
  ).toHaveLength(1);

  // Go online to start replay, but don't resolve yet.
  act(() => {
    network.goOnline();
  });
  await waitForMicrotaskCondition(() => resolveReplay !== undefined);

  // Switch to a new session while replay is in-flight, then resolve.
  // The completed entry should be cleaned from session-a's namespace.
  expect(resolveReplay).toBeDefined();
  sessionKey = 'replay-session-b';
  resolveReplay?.({ value: 2 });
  await flushAllTimers();

  // No leftover queue entries in the old session namespace.
  expect(
    getLocalStorageKeys().filter((key) =>
      key.startsWith('tsdf.replay-session-a.replay-session-switch-doc.oq.'),
    ),
  ).toMatchInlineSnapshot(`[]`);
});

test('document offline mutations are queued durably and replay when the browser comes back online', async () => {
  network.setOffline();

  const sessionKey = 'offline-doc-session';
  const storeName = 'offline-doc-store';
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

  const hook = renderHook(() => {
    const doc = env.apiStore.useDocument();
    env.trackUIChanges(
      `value:${doc.data?.value ?? 'null'} pending:${doc.pendingSync ? 'yes' : 'no'}`,
    );
    return doc;
  });

  await Promise.resolve();

  // Queue an optimistic document mutation while the browser is offline.
  let mutationResult:
    | Awaited<ReturnType<typeof env.apiStore.performMutation>>
    | undefined;
  await act(async () => {
    mutationResult = await env.apiStore.performMutation({
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
  });

  expect(mutationResult?.ok).toBe(true);
  expect(env.store.state.data).toMatchInlineSnapshot(`
    value: 2
  `);

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: 'document'
      entityKind: 'document'
      id: 'offline-doc-session:offline-doc-store:document'
      kind: 'update'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'offline-doc-session'
      storeName: 'offline-doc-store'
      storeType: 'document'
      syncState: 'pending'
      updatedAt: 1735689600000
  `);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);

  // The optimistic value should stay visible while replay is still pending.
  expect(hook.result.current).toMatchInlineSnapshot(`
    data: { value: 2 }
    error: null
    isLoading: '❌'
    pendingSync: '✅'
    status: 'success'
  `);

  // Once connectivity returns, replay should clear the queue and then
  // revalidate from the server, settling back onto confirmed server data.
  env.addTimelineComments('beforeNextAction', [
    'browser comes back online — replay starts and a revalidation fetch follows',
  ]);
  act(() => {
    network.goOnline();
  });
  await advanceTime(250);
  await flushAllTimers();

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  expect(hook.result.current).toMatchInlineSnapshot(`
    data: { value: 2 }
    error: null
    isLoading: '❌'
    pendingSync: '❌'
    status: 'success'
  `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                    |
    0     | "value:1 pending:no"  | ui-initialized
    .     | "value:2 pending:no"  | ui-changed
    .     | "value:2 pending:yes" | ui-changed
    .     | "value:2 pending:yes" | offline:updateValue queued
    .     | "value:2 pending:yes" | -- browser comes back online — replay starts and a revalidation fetch follows
    .     | "value:2 pending:yes" | offline:updateValue replay-started
    10ms  | "value:2 pending:yes" | 🔴 >fetch-started
    810ms | "value:2 pending:yes" | 🔴 <fetch-finished (value: 1)
    1.2s  | "value:2 pending:yes" | server-data-changed (value: 2)
    .     | "value:2 pending:yes" | offline:updateValue replay-finished
    .     | "value:2 pending:no"  | ui-changed
    1.21s | "value:2 pending:no"  | 🟠 >fetch-started
    2.01s | "value:2 pending:no"  | 🟠 <fetch-finished (value: 2)
    "
  `);
  hook.unmount();
});

test('accumulation still merges entries when the queue starts from a hybrid fallback', async () => {
  const sessionKey = 'hybrid-accumulation-session';
  const storeName = 'hybrid-accumulation-store';
  // Simulates a mutation that fails at the network level (not queued offline
  // preemptively, but falls back to the offline queue after the error).
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
            accumulation: { mergeInput: ({ incomingInput }) => incomingInput },
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

  // The first mutation attempts a direct send, which fails with an outage
  // error — falling back to the offline queue. The second mutation should
  // merge into that fallback entry via accumulation rather than creating a
  // separate queue entry.
  await env.apiStore.performMutation({
    optimisticUpdate: () => {
      env.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: directMutation,
    offline: { operation: 'updateValue', input: { value: 2 } },
  });
  await env.apiStore.performMutation({
    optimisticUpdate: () => {
      env.apiStore.updateState((draft) => {
        draft.value = 3;
      });
    },
    mutation: async () => {
      await env.serverMock.delayedSetData(3);
      return 3;
    },
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  // Only the first mutation attempted a direct send; the second was queued
  // directly because the session is already in outage mode.
  expect(directMutation).toHaveBeenCalledTimes(1);
  expect(env.store.state.data).toMatchInlineSnapshot(`
    value: 3
  `);
  // Accumulation merged both mutations into a single queue entry with the
  // latest input (value: 3).
  expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);

  expect(
    pick(
      getOfflineQueueEntryData(
        getOfflineQueueEntries(sessionKey, storeName)[0]!,
      ),
      [
        'attempts',
        'createdAt',
        'entityRefs',
        'input',
        'lastAttemptAt',
        'operation',
        'queueOrder',
        'sessionKey',
        'storeName',
        'storeType',
        'syncState',
        'updatedAt',
      ],
    ),
  ).toMatchInlineSnapshot(`
    attempts: 0
    createdAt: 1735689600000
    entityRefs:
      - { entityKey: 'document', entityKind: 'document' }
    input: { value: 3 }
    lastAttemptAt: null
    operation: 'updateValue'
    queueOrder: 1735689600000
    sessionKey: 'hybrid-accumulation-session'
    storeName: 'hybrid-accumulation-store'
    storeType: 'document'
    syncState: 'pending'
    updatedAt: 1735689600000
  `);
});

test('mutations queued via hybrid fallback enter the resolution queue after replay retries are exhausted', async () => {
  // Execute always fails, so the replay budget will be exhausted quickly.
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockRejectedValue(createReplayFailure('replay failed'));
  // Low retry budget (maxFailures: 2, intervalMs: 1) so the test completes
  // quickly. recoveryCheck returns true so recovery probes don't block replay.
  const env = createDocumentStoreTestEnv<number, UpdateValueConflictOperations>(
    1,
    {
      getSessionKey: () => 'hybrid-retry-exhaustion-session',
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => 'hybrid-retry-exhaustion-session',
        offlineSession: {
          network: network.config,
          classifyFailure: (error, ctx) =>
            classifyMutationOutage(error, ctx.phase) ? 'outage' : 'ignore',
          classifyRetryableFailure: (error, ctx) =>
            classifyRetryableReplayFailure(error, ctx.phase),
          outage: {
            enabled: true,
            recoveryCheck: () => true,
            recoveryProbe: quickRecoveryProbe,
          },
          // Low retry budget so the test exhausts it quickly.
          replayRetry: { maxFailures: 2, intervalMs: 500 },
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
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateState((draft) => {
                  draft.value = input.value;
                });
              },
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: () => false,
              },
            },
          },
        },
      },
    },
  );

  // The direct mutation fails, falling back to the offline queue.
  const result = await env.apiStore.performMutation({
    mutation: () => Promise.reject(new Error('offline-fallback')),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  // Fallback queueing reports success with a "queued" marker.
  expect({ ok: result.ok, value: result.ok ? result.value : null })
    .toMatchInlineSnapshot(`
      ok: '✅'
      value: { kind: 'queued' }
    `);

  // Let replay attempts exhaust the retry budget.
  await advanceTime(500);
  await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);

  await advanceTime(500);
  await waitForMicrotaskCondition(
    () => env.apiStore.getOfflineResolutions().length === 1,
  );

  // The fallback-queued mutation should end up as a retry-exhausted resolution,
  // proving that hybrid fallback entries follow the same retry exhaustion path
  // as preemptively queued entries.
  expect(env.apiStore.getOfflineResolutions().map(summarizeResolution))
    .toMatchInlineSnapshot(`
      - error: 'replay failed'
        input: 'value: 2'
        kind: 'retry-exhausted'
        on: 'document:document'
        op: 'updateValue'
    `);
});

test('an edit made right after reconnecting is sent after the edits still waiting in the offline queue', async () => {
  network.setOffline();

  const sessionKey = 'offline-online-edit-ordering-session';
  const storeName = 'offline-online-edit-ordering-store';
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
              // Replaying over the connection that just came back is slow.
              await env.serverMock.delayedSetData(input.value, {
                durationMs: 3000,
              });
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

  function editValue(value: number) {
    return env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = value;
        });
      },
      mutation: async () => {
        await env.serverMock.delayedSetData(value);
        return value;
      },
      offline: { operation: 'updateValue', input: { value } },
    });
  }

  const hook = renderHook(() => {
    const doc = env.apiStore.useDocument();
    env.trackUIChanges(
      `value:${doc.data?.value ?? 'null'} pending:${doc.pendingSync ? 'yes' : 'no'}`,
    );
    return doc;
  });
  await Promise.resolve();

  // First edit happens offline, so it waits in the queue.
  env.addTimelineComments('beforeNextAction', ['offline: edit the value to 2']);
  await act(async () => {
    await editValue(2);
  });

  // Back online: the queued edit starts replaying, and the user edits again
  // before that replay reaches the server.
  env.addTimelineComments('beforeNextAction', [
    'back online: the queued edit starts replaying',
  ]);
  act(() => {
    network.goOnline();
  });
  await advanceTime(500);

  env.addTimelineComments('beforeNextAction', [
    'the user edits the value to 3 while the first edit is still replaying',
  ]);
  let secondEdit: ReturnType<typeof editValue> | undefined;
  act(() => {
    secondEdit = editValue(3);
  });
  await flushAllTimers();
  const secondEditResult = await secondEdit;

  // The second edit is not sent on its own (it would reach the server before
  // the older queued edit, which would then overwrite it): it is queued
  // behind the first one, so the server receives 2 and then 3.
  expect(secondEditResult?.ok).toBe(true);
  // The value shown after everything settled comes from the server (the
  // store revalidates once the queue is drained), so it proves the latest
  // edit is the one that won there.
  expect(hook.result.current.data).toMatchInlineSnapshot(`value: 3`);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                    |
    0     | "value:1 pending:no"  | ui-initialized
    .     | "value:1 pending:no"  | -- offline: edit the value to 2
    .     | "value:2 pending:no"  | ui-changed
    .     | "value:2 pending:yes" | ui-changed
    .     | "value:2 pending:yes" | offline:updateValue queued
    .     | "value:2 pending:yes" | -- back online: the queued edit starts replaying
    .     | "value:2 pending:yes" | offline:updateValue replay-started
    10ms  | "value:2 pending:yes" | 🔴 >fetch-started
    500ms | "value:2 pending:yes" | -- the user edits the value to 3 while the first edit is still replaying
    .     | "value:2 pending:yes" | 🔴 <fetch-aborted 🚫
    .     | "value:3 pending:yes" | ui-changed
    .     | "value:3 pending:yes" | offline:updateValue queued
    820ms | "value:3 pending:yes" | 🟠 >fetch-started
    1.62s | "value:3 pending:yes" | 🟠 <fetch-finished (value: 1)
    3s    | "value:3 pending:yes" | server-data-changed (value: 2)
    .     | "value:3 pending:yes" | offline:updateValue replay-finished
    .     | "value:3 pending:yes" | offline:updateValue replay-started
    6s    | "value:3 pending:yes" | server-data-changed (value: 3)
    .     | "value:3 pending:yes" | offline:updateValue replay-finished
    .     | "value:3 pending:no"  | ui-changed
    6.01s | "value:3 pending:no"  | 🟡 >fetch-started
    6.81s | "value:3 pending:no"  | 🟡 <fetch-finished (value: 3)
    "
  `);

  hook.unmount();
});

test('an item created right after reconnecting on top of an offline creation is sent once that creation reached the server', async () => {
  network.setOffline();
  const sessionKey = 'offline-online-dependent-create-session';

  type FolderOperations = {
    createFolder: CollectionOfflineOperationDefinition<
      { value: { name: string; parentId?: string } },
      string,
      { name: string },
      unknown,
      { id: string }
    >;
    createSubfolder: CollectionOfflineOperationDefinition<
      { value: { name: string; parentId?: string } },
      string,
      { name: string; parentId: string },
      unknown,
      { id: string }
    >;
  };

  const folderSchema = rc_object({
    value: rc_object({ name: rc_string, parentId: rc_string.optionalKey() }),
  });

  const env = createCollectionStoreTestEnv<
    { name: string; parentId?: string },
    FolderOperations
  >(
    {},
    {
      id: 'offline-online-dependent-create-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      persistentStorage: {
        adapter: 'local-sync',
        schema: folderSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            createFolder: {
              inputSchema: collectionCreateInputSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              tempEntity: {
                buildPendingEntity: (input) => ({
                  value: { name: input.name },
                }),
                reconcileServerEntity: (result) => ({
                  finalPayload: result.id,
                }),
              },
              execute: async ({ input }) => {
                // Replaying over the connection that just came back is slow.
                await env.serverTable.delayedSetItem(
                  'folders||1',
                  { name: input.name },
                  { durationMs: 3000 },
                );
                return { id: 'folders||1' };
              },
            },
            createSubfolder: {
              inputSchema: rc_object({ name: rc_string, parentId: rc_string }),
              kind: 'create',
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              dependsOn: ({ input }) => [input.parentId],
              tempEntity: {
                buildPendingEntity: (input) => ({
                  value: { name: input.name, parentId: input.parentId },
                }),
                reconcileServerEntity: (result) => ({
                  finalPayload: result.id,
                }),
              },
              execute: async ({ input }) => {
                await env.serverTable.delayedSetItem('folders||2', input);
                return { id: 'folders||2' };
              },
            },
          },
        },
      },
    },
  );

  // Create a folder offline: it only exists locally, under a temp id.
  await act(async () => {
    await env.apiStore.performMutation(null, {
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: { operation: 'createFolder', input: { name: 'Docs' } },
    });
  });

  // Back online: the folder creation starts replaying, and the user creates
  // a subfolder in it before that replay reaches the server.
  act(() => {
    network.goOnline();
  });
  await advanceTime(500);

  const sendSubfolderDirectly = vi.fn(() =>
    Promise.reject(new Error('the parent folder does not exist yet')),
  );
  let subfolderResult:
    | Awaited<ReturnType<typeof env.apiStore.performMutation>>
    | undefined;
  await act(async () => {
    subfolderResult = await env.apiStore.performMutation(null, {
      mutation: sendSubfolderDirectly,
      offline: {
        operation: 'createSubfolder',
        input: { name: 'Invoices', parentId: 'temp:Docs' },
      },
    });
  });
  await flushAllTimers();

  // Sent on its own, the subfolder would reference a folder the server does
  // not have yet: it is queued behind the folder creation instead, and
  // replayed with the folder's server id.
  expect(sendSubfolderDirectly).not.toHaveBeenCalled();
  expect(subfolderResult?.ok).toBe(true);
  expect(env.serverTable.getAll()).toMatchInlineSnapshot(`
    folders||1: { name: 'Docs' }
    folders||2: { name: 'Invoices', parentId: 'folders||1' }
  `);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
});

test('lists are revalidated after replaying an offline creation that references no entity', async () => {
  network.setOffline();
  const sessionKey = 'offline-entityless-create-session';

  type EntitylessCreateOperations = {
    createUser: ListQueryOfflineOperationDefinition<
      { id: number; name: string },
      ListQueryParams,
      string,
      { name: string },
      unknown
    >;
  };

  // The server assigns the id and the app shows no optimistic row, so the
  // operation references no entity: only the revalidation after the replay
  // can bring the new row into the list.
  const env = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    EntitylessCreateOperations
  >(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      id: 'offline-entityless-create-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          operations: {
            createUser: {
              inputSchema: collectionCreateInputSchema,
              kind: 'create',
              getEntityRefs: () => [],
              execute: async ({ input }) => {
                await env.serverTable.addItemWithAutoGeneratedKey(
                  'users',
                  (id) => ({ id, name: input.name }),
                );
              },
              // Nothing to sync locally: the list revalidation shows the row.
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(
      { tableId: 'users' },
      { itemSelector: (item) => item.name },
    );
    env.trackItemUI('users', query.items.join(', '));
  });
  await flushAllTimers();

  // Create Grace offline: the creation waits in the queue.
  await act(async () => {
    await env.apiStore.performMutation(null, {
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: { operation: 'createUser', input: { name: 'Grace' } },
    });
  });

  // Back online: the list must only be revalidated once the creation reached
  // the server, otherwise it would be fetched without Grace and never again.
  env.addTimelineComments('beforeNextAction', [
    'back online: the creation is replayed, then the list revalidated',
  ]);
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | users      |
    0     | Ada        | [users] ui-initialized
    3.01s | Ada        | offline:createUser queued
    .     | Ada        | -- back online: the creation is replayed, then the list revalidated
    .     | Ada        | offline:createUser replay-started
    .     | Ada        | [users||2] >add-item-started (value: {"id":2,"name":"Grace"})
    3.85s | Ada        | [users||2] <add-item-persisted (value: {"id":2,"name":"Grace"})
    4.21s | Ada        | offline:createUser replay-finished
    4.22s | Ada        | 🔴 >list-fetch-started
    5.02s | Ada        | 🔴 <list-fetch-finished (value: {"count":2})
    .     | Ada, Grace | [users] ui-changed
    "
  `);

  hook.unmount();
});

test('an offline creation that references no entity and waits for a decision delays the list revalidation until it is handled', async () => {
  network.setOffline();
  const sessionKey = 'offline-entityless-conflict-session';

  type EntitylessCreateOperations = {
    createUser: ListQueryOfflineOperationDefinition<
      { id: number; name: string },
      ListQueryParams,
      string,
      { name: string },
      { reason: string }
    >;
  };

  // The server assigns the id, so the operation references no entity. On
  // replay the app detects a conflict, so the creation waits for the user.
  const env = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    EntitylessCreateOperations
  >(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      id: 'offline-entityless-conflict-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          operations: {
            createUser: {
              inputSchema: collectionCreateInputSchema,
              kind: 'create',
              getEntityRefs: () => [],
              execute: async ({ input }) => {
                await env.serverTable.addItemWithAutoGeneratedKey(
                  'users',
                  (id) => ({ id, name: input.name }),
                );
              },
              onSuccessExecute: () => {},
              conflictHandling: {
                schema: rc_object({ reason: rc_string }),
                detectConflict: () => ({ reason: 'needs-review' }),
              },
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(
      { tableId: 'users' },
      { itemSelector: (item) => item.name },
    );
    env.trackItemUI('users', query.items.join(', '));
  });
  await flushAllTimers();

  // Create Grace offline: the creation waits in the queue.
  await act(async () => {
    await env.apiStore.performMutation(null, {
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: { operation: 'createUser', input: { name: 'Grace' } },
    });
  });

  // Back online: the replay stops at the conflict. The store still has a
  // change waiting for a decision, so its list is not revalidated yet.
  env.addTimelineComments('beforeNextAction', [
    'back online: the creation waits for a decision, no list revalidation',
  ]);
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution) throw new Error('Expected a pending resolution');

  // The user handles the conflict through the app's own API, which creates
  // Grace on the server, then commits it: only now the list is revalidated
  // and shows the new row.
  env.serverTable.setItem('users||2', { id: 2, name: 'Grace' });
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(resolution.id, 'createUser', {
      action: 'commit',
    });
  });
  env.addTimelineComments('afterLastAction', [
    'Grace created through the app API, then the resolution was committed',
  ]);
  await flushAllTimers();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | users      |
    0     | Ada        | [users] ui-initialized
    3.01s | Ada        | offline:createUser queued
    .     | Ada        | -- back online: the creation waits for a decision, no list revalidation
    .     | Ada        | offline:createUser resolution-required
    .     | Ada        | [users||2] server-data-changed (value: {"id":2,"name":"Grace"})
    .     | Ada        | -- Grace created through the app API, then the resolution was committed
    3.02s | Ada        | 🔴 >list-fetch-started
    3.82s | Ada        | 🔴 <list-fetch-finished (value: {"count":2})
    .     | Ada, Grace | [users] ui-changed
    "
  `);

  hook.unmount();
});

test('discarding one of two failed offline changes of a document keeps the other one visible until it is handled', async () => {
  const sessionKey = 'offline-discard-document-pending-session';

  // The server rejects every change, so they end up waiting for the user to
  // decide what to do with them.
  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
        network: network.config,
        classifyRetryableFailure: (error, ctx) =>
          classifyRetryableReplayFailure(error, ctx.phase),
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
            execute: () => {
              throw new Error('update rejected');
            },
            onSuccessExecute: () => {},
          },
        },
      },
    },
  });

  const hook = renderHook(() => {
    const doc = env.apiStore.useDocument();
    env.trackUIChanges(`value:${doc.data?.value ?? 'null'}`);
  });
  // Let the mount revalidation finish while online.
  await advanceTime(1_000);

  const updateValueOffline = async (value: number) => {
    await act(async () => {
      await env.apiStore.performMutation({
        optimisticUpdate: () => {
          env.apiStore.updateState((draft) => {
            draft.value = value;
          });
        },
        mutation: () => Promise.reject(new Error('unreachable while offline')),
        offline: { operation: 'updateValue', input: { value } },
      });
    });
  };

  env.addTimelineComments('beforeNextAction', [
    'offline: change the value to 2, then to 3',
  ]);
  await act(async () => {
    network.goOffline();
    await Promise.resolve();
  });
  await updateValueOffline(2);
  await updateValueOffline(3);

  env.addTimelineComments('beforeNextAction', [
    'back online: the server rejects both changes until they need a resolution',
  ]);
  act(() => {
    network.goOnline();
  });
  // 3 attempts per change, 5s apart: 30s covers both.
  await advanceTime(30_000);
  await flushAllTimers();

  const [firstResolution, secondResolution] =
    env.apiStore.getOfflineResolutions();
  if (!firstResolution || !secondResolution) {
    throw new Error('Expected both changes to be waiting for a resolution');
  }
  expect(
    [firstResolution, secondResolution].map(
      (resolution) => summarizeResolution(resolution).input,
    ),
  ).toMatchInlineSnapshot(`['value: 2', 'value: 3']`);

  // Discard the first change. Refetching the document now would replace the
  // second change, which still waits for a decision: the document keeps
  // showing it.
  env.addTimelineComments('beforeNextAction', [
    'discard the change to 2: no refetch, the change to 3 is still shown',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      firstResolution.id,
      'updateValue',
      { action: 'discard' },
    );
  });
  await flushAllTimers();

  // Discarding the last change refetches the document: it shows the server
  // value again.
  env.addTimelineComments('beforeNextAction', [
    'discard the change to 3: the document is refetched',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      secondResolution.id,
      'updateValue',
      { action: 'discard' },
    );
  });
  await flushAllTimers();

  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui        |
    0      | "value:1" | ui-initialized
    10ms   | "value:1" | 🔴 >fetch-started
    810ms  | "value:1" | 🔴 <fetch-finished (value: 1)
    1s     | "value:1" | -- offline: change the value to 2, then to 3
    .      | "value:2" | ui-changed
    .      | "value:2" | offline:updateValue queued
    .      | "value:3" | ui-changed
    .      | "value:3" | offline:updateValue queued
    .      | "value:3" | -- back online: the server rejects both changes until they need a resolution
    .      | "value:3" | offline:updateValue replay-started
    6s     | "value:3" | offline:updateValue replay-started
    11s    | "value:3" | offline:updateValue replay-started
    .      | "value:3" | offline:updateValue resolution-required
    .      | "value:3" | offline:updateValue replay-started
    16s    | "value:3" | offline:updateValue replay-started
    21s    | "value:3" | offline:updateValue replay-started
    .      | "value:3" | offline:updateValue resolution-required
    31.01s | "value:3" | -- discard the change to 2: no refetch, the change to 3 is still shown
    .      | "value:3" | -- discard the change to 3: the document is refetched
    .      | "value:3" | 🟠 >fetch-started
    31.81s | "value:3" | 🟠 <fetch-finished (value: 1)
    .      | "value:1" | ui-changed
    "
  `);

  hook.unmount();
});

test('discarding one of two failed offline changes of a collection item keeps the other one visible until it is handled', async () => {
  network.setOffline();
  const sessionKey = 'offline-discard-collection-pending-session';

  type RejectedRenameOperations = {
    patchUserName: CollectionOfflineOperationDefinition<
      { value: { name: string } },
      string,
      { itemId: string; name: string },
      unknown
    >;
  };

  // The server rejects every rename, so they end up waiting for the user to
  // decide what to do with them.
  const env = createCollectionStoreTestEnv<
    { name: string },
    RejectedRenameOperations
  >(
    { 'users||1': { name: 'Ada' } },
    {
      id: 'offline-discard-collection-pending-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
          network: network.config,
          classifyRetryableFailure: (error, ctx) =>
            classifyRetryableReplayFailure(error, ctx.phase),
        },
      }),
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            patchUserName: {
              inputSchema: userPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: () => {
                throw new Error('rename rejected');
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const ada = env.apiStore.useItem('users||1');
    env.trackItemUI('ada', ada.data?.value.name ?? `- ${ada.status}`);
  });
  await advanceTime(1_000);

  const renameAdaOffline = async (name: string) => {
    await act(async () => {
      await env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('users||1', () => ({ value: { name } }));
        },
        mutation: () => Promise.reject(new Error('unreachable while offline')),
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name },
        },
      });
    });
  };

  env.addTimelineComments('beforeNextAction', ['offline: rename Ada twice']);
  await renameAdaOffline('Ada renamed');
  await renameAdaOffline('Ada renamed again');

  env.addTimelineComments('beforeNextAction', [
    'back online: the server rejects both renames until they need a resolution',
  ]);
  act(() => {
    network.goOnline();
  });
  // 3 attempts per rename, 5s apart: 30s covers both.
  await advanceTime(30_000);
  await flushAllTimers();

  const [firstRename, secondRename] = env.apiStore.getOfflineResolutions();
  if (!firstRename || !secondRename) {
    throw new Error('Expected both renames to be waiting for a resolution');
  }

  // Discard the first rename. Refetching Ada now would replace the second
  // rename, which still waits for a decision: she keeps showing it.
  env.addTimelineComments('beforeNextAction', [
    'discard the first rename: no refetch, the second rename is still shown',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      firstRename.id,
      'patchUserName',
      { action: 'discard' },
    );
  });
  await flushAllTimers();

  // Discarding the last rename refetches Ada: she shows the server name.
  env.addTimelineComments('beforeNextAction', [
    'discard the second rename: Ada is refetched',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      secondRename.id,
      'patchUserName',
      { action: 'discard' },
    );
  });
  await flushAllTimers();

  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ada               |
    0      | Ada               | [ada] ui-initialized
    1s     | Ada               | -- offline: rename Ada twice
    .      | Ada renamed       | [ada] ui-changed
    .      | Ada renamed       | offline:patchUserName queued
    .      | Ada renamed again | [ada] ui-changed
    .      | Ada renamed again | offline:patchUserName queued
    .      | Ada renamed again | -- back online: the server rejects both renames until they need a resolution
    .      | Ada renamed again | offline:patchUserName replay-started
    6s     | Ada renamed again | offline:patchUserName replay-started
    11s    | Ada renamed again | offline:patchUserName replay-started
    .      | Ada renamed again | offline:patchUserName resolution-required
    .      | Ada renamed again | offline:patchUserName replay-started
    16s    | Ada renamed again | offline:patchUserName replay-started
    21s    | Ada renamed again | offline:patchUserName replay-started
    .      | Ada renamed again | offline:patchUserName resolution-required
    31.01s | Ada renamed again | -- discard the first rename: no refetch, the second rename is still shown
    .      | Ada renamed again | -- discard the second rename: Ada is refetched
    .      | Ada renamed again | 🔴 [users||1] >fetch-started
    31.81s | Ada renamed again | 🔴 [users||1] <fetch-finished (value: {"name":"Ada"})
    .      | Ada               | [ada] ui-changed
    "
  `);

  hook.unmount();
});

test('discarding failed offline changes of collection items puts those items back to the server values', async () => {
  network.setOffline();
  const sessionKey = 'offline-discard-collection-item-session';

  type RejectedChangeOperations = {
    patchUserName: CollectionOfflineOperationDefinition<
      { value: { name: string } },
      string,
      { itemId: string; name: string },
      unknown
    >;
    deleteUser: CollectionOfflineOperationDefinition<
      { value: { name: string } },
      string,
      { itemId: string },
      unknown
    >;
  };

  // The server rejects every change, so they end up waiting for the user to
  // decide what to do with them.
  const env = createCollectionStoreTestEnv<
    { name: string },
    RejectedChangeOperations
  >(
    { 'users||1': { name: 'Ada' }, 'users||2': { name: 'Grace' } },
    {
      id: 'offline-discard-collection-item-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
          network: network.config,
          classifyRetryableFailure: (error, ctx) =>
            classifyRetryableReplayFailure(error, ctx.phase),
        },
      }),
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            patchUserName: {
              inputSchema: userPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: () => {
                throw new Error('rename rejected');
              },
              onSuccessExecute: () => {},
            },
            deleteUser: {
              inputSchema: deleteItemInputSchema,
              kind: 'delete',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: () => {
                throw new Error('delete rejected');
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const ada = env.apiStore.useItem('users||1');
    const grace = env.apiStore.useItem('users||2');

    env.trackItemUI('ada', ada.data?.value.name ?? `- ${ada.status}`);
    env.trackItemUI('grace', grace.data?.value.name ?? `- ${grace.status}`);
  });
  await flushAllTimers();

  env.addTimelineComments('beforeNextAction', [
    'offline: rename Ada and delete Grace',
  ]);
  await act(async () => {
    await env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', () => ({
          value: { name: 'Ada renamed' },
        }));
      },
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada renamed' },
      },
    });
    await env.apiStore.performMutation('users||2', {
      optimisticUpdate: () => {
        env.apiStore.deleteItemState('users||2');
      },
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: { operation: 'deleteUser', input: { itemId: 'users||2' } },
    });
  });

  env.addTimelineComments('beforeNextAction', [
    'back online: the server rejects both changes until they need a resolution',
  ]);
  act(() => {
    network.goOnline();
  });
  // 3 attempts per change, 5s apart: 30s covers both.
  await advanceTime(30_000);
  await flushAllTimers();

  const renameResolution = env.apiStore
    .getOfflineResolutions()
    .find((resolution) => resolution.operation === 'patchUserName');
  const deleteResolution = env.apiStore
    .getOfflineResolutions()
    .find((resolution) => resolution.operation === 'deleteUser');
  if (!renameResolution || !deleteResolution) {
    throw new Error('Expected both changes to be waiting for a resolution');
  }

  // Discard only Grace's delete. The delete removed her item locally, so
  // there is nothing left in the store to invalidate: the store fetches her
  // item again and she shows up with the server value. Ada's rename is still
  // waiting for a decision, so her item is untouched.
  env.addTimelineComments('beforeNextAction', [
    'discard the delete of Grace: only Grace is refetched',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      deleteResolution.id,
      'deleteUser',
      { action: 'discard' },
    );
  });
  await flushAllTimers();

  // Discard the rename: Ada is refetched and shows the server name.
  env.addTimelineComments('beforeNextAction', [
    'discard the rename of Ada: Ada is refetched',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      renameResolution.id,
      'patchUserName',
      { action: 'discard' },
    );
  });
  await flushAllTimers();

  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ada         | grace     |
    0      | Ada         | Grace     | [ada, grace] ui-initialized
    1.01s  | Ada         | Grace     | -- offline: rename Ada and delete Grace
    .      | Ada renamed | Grace     | [ada] ui-changed
    .      | Ada renamed | Grace     | offline:patchUserName queued
    .      | Ada renamed | - deleted | [grace] ui-changed
    .      | Ada renamed | - deleted | offline:deleteUser queued
    .      | Ada renamed | - deleted | -- back online: the server rejects both changes until they need a resolution
    .      | Ada renamed | - deleted | offline:patchUserName replay-started
    6.01s  | Ada renamed | - deleted | offline:patchUserName replay-started
    11.01s | Ada renamed | - deleted | offline:patchUserName replay-started
    .      | Ada renamed | - deleted | offline:patchUserName resolution-required
    .      | Ada renamed | - deleted | offline:deleteUser replay-started
    16.01s | Ada renamed | - deleted | offline:deleteUser replay-started
    21.01s | Ada renamed | - deleted | offline:deleteUser replay-started
    .      | Ada renamed | - deleted | offline:deleteUser resolution-required
    31.02s | Ada renamed | - deleted | -- discard the delete of Grace: only Grace is refetched
    .      | Ada renamed | - loading | [grace] ui-changed
    .      | Ada renamed | - loading | 🔴 [users||2] >fetch-started
    31.82s | Ada renamed | - loading | 🔴 [users||2] <fetch-finished (value: {"name":"Grace"})
    .      | Ada renamed | Grace     | [grace] ui-changed
    32.83s | Ada renamed | Grace     | -- discard the rename of Ada: Ada is refetched
    .      | Ada renamed | Grace     | 🟠 [users||1] >fetch-started
    .      | Ada renamed | Grace     | 🟡 [users||2] >fetch-started
    33.63s | Ada renamed | Grace     | 🟠 [users||1] <fetch-finished (value: {"name":"Ada"})
    .      | Ada         | Grace     | [ada] ui-changed
    .      | Ada         | Grace     | 🟡 [users||2] <fetch-finished (value: {"name":"Grace"})
    "
  `);

  hook.unmount();
});

test('discarding a failed offline creation puts existing items changed on top of it back to the server values', async () => {
  network.setOffline();
  const sessionKey = 'offline-discard-create-dependents-session';

  type TeamUser = { name: string; teamId?: string };
  type TeamOperations = {
    createTeam: CollectionOfflineOperationDefinition<
      { value: TeamUser },
      string,
      { name: string },
      unknown,
      { id: string }
    >;
    moveUserToTeam: CollectionOfflineOperationDefinition<
      { value: TeamUser },
      string,
      { itemId: string; teamId: string },
      unknown
    >;
    patchUserName: CollectionOfflineOperationDefinition<
      { value: TeamUser },
      string,
      { itemId: string; name: string },
      unknown
    >;
  };

  // The server rejects the team creation and the rename, so they end up
  // waiting for the user to decide what to do with them.
  const env = createCollectionStoreTestEnv<TeamUser, TeamOperations>(
    { 'users||1': { name: 'Ada' }, 'users||2': { name: 'Grace' } },
    {
      id: 'offline-discard-create-dependents-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
          network: network.config,
          classifyRetryableFailure: (error, ctx) =>
            classifyRetryableReplayFailure(error, ctx.phase),
        },
      }),
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: rc_object({
          value: rc_object({
            name: rc_string,
            teamId: rc_string.optionalKey(),
          }),
        }),
        payloadSchema: rc_string,
        offline: {
          operations: {
            createTeam: {
              inputSchema: collectionCreateInputSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              tempEntity: {
                buildPendingEntity: (input) => ({
                  value: { name: input.name },
                }),
                reconcileServerEntity: (result) => ({
                  finalPayload: result.id,
                }),
              },
              execute: () => {
                throw new Error('team creation rejected');
              },
            },
            moveUserToTeam: {
              inputSchema: rc_object({ itemId: rc_string, teamId: rc_string }),
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              dependsOn: ({ input }) => [input.teamId],
              execute: async ({ input }) => {
                await env.serverTable.delayedUpdateItem(input.itemId, {
                  teamId: input.teamId,
                });
              },
              onSuccessExecute: () => {},
            },
            patchUserName: {
              inputSchema: userPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: () => {
                throw new Error('rename rejected');
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const ada = env.apiStore.useItem('users||1');
    const grace = env.apiStore.useItem('users||2');

    env.trackItemUI(
      'ada',
      `${ada.data?.value.name} in ${ada.data?.value.teamId ?? 'no team'}`,
    );
    env.trackItemUI('grace', grace.data?.value.name ?? `- ${grace.status}`);
  });
  await flushAllTimers();

  env.addTimelineComments('beforeNextAction', [
    'offline: create a team, move Ada into it and rename Grace',
  ]);
  await act(async () => {
    await env.apiStore.performMutation(null, {
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: { operation: 'createTeam', input: { name: 'Core' } },
    });
    await env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', (user) => ({
          value: { ...user.value, teamId: 'temp:Core' },
        }));
      },
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: {
        operation: 'moveUserToTeam',
        input: { itemId: 'users||1', teamId: 'temp:Core' },
      },
    });
    await env.apiStore.performMutation('users||2', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||2', () => ({
          value: { name: 'Grace renamed' },
        }));
      },
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||2', name: 'Grace renamed' },
      },
    });
  });

  env.addTimelineComments('beforeNextAction', [
    'back online: the server rejects the team and the rename until they need a resolution',
  ]);
  act(() => {
    network.goOnline();
  });
  // 3 attempts per change, 5s apart: 30s covers both.
  await advanceTime(30_000);
  await flushAllTimers();

  const teamResolution = env.apiStore
    .getOfflineResolutions()
    .find((resolution) => resolution.operation === 'createTeam');
  if (!teamResolution) {
    throw new Error('Expected the team creation to wait for a resolution');
  }

  // Discarding the team also discards the move of Ada, which was made on top
  // of it: Ada is refetched and leaves the team that never existed. Grace's
  // rename is still waiting for a decision, so her item is untouched.
  env.addTimelineComments('beforeNextAction', [
    'discard the team creation: the move of Ada is discarded with it',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      teamResolution.id,
      'createTeam',
      { action: 'discard' },
    );
  });
  await flushAllTimers();

  expect(
    env.apiStore
      .getOfflineResolutions()
      .map((resolution) => resolution.operation),
  ).toMatchInlineSnapshot(`['patchUserName']`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ada              | grace         |
    0      | Ada in no team   | Grace         | [ada, grace] ui-initialized
    1.01s  | Ada in no team   | Grace         | -- offline: create a team, move Ada into it and rename Grace
    .      | Ada in no team   | Grace         | offline:createTeam queued
    .      | Ada in temp:Core | Grace         | [ada] ui-changed
    .      | Ada in temp:Core | Grace         | offline:moveUserToTeam queued
    .      | Ada in temp:Core | Grace renamed | [grace] ui-changed
    .      | Ada in temp:Core | Grace renamed | offline:patchUserName queued
    .      | Ada in temp:Core | Grace renamed | -- back online: the server rejects the team and the rename until they need a resolution
    .      | Ada in temp:Core | Grace renamed | offline:createTeam replay-started
    6.01s  | Ada in temp:Core | Grace renamed | offline:createTeam replay-started
    11.01s | Ada in temp:Core | Grace renamed | offline:createTeam replay-started
    .      | Ada in temp:Core | Grace renamed | offline:createTeam resolution-required
    .      | Ada in temp:Core | Grace renamed | offline:moveUserToTeam resolution-required
    .      | Ada in temp:Core | Grace renamed | offline:patchUserName replay-started
    16.01s | Ada in temp:Core | Grace renamed | offline:patchUserName replay-started
    21.01s | Ada in temp:Core | Grace renamed | offline:patchUserName replay-started
    .      | Ada in temp:Core | Grace renamed | offline:patchUserName resolution-required
    31.02s | Ada in temp:Core | Grace renamed | -- discard the team creation: the move of Ada is discarded with it
    .      | Ada in temp:Core | Grace renamed | 🔴 [users||1] >fetch-started
    31.82s | Ada in temp:Core | Grace renamed | 🔴 [users||1] <fetch-finished (value: {"name":"Ada"})
    .      | Ada in no team   | Grace renamed | [ada] ui-changed
    "
  `);

  hook.unmount();
});

test('an offline creation that keeps its client-generated id shows the server value once replayed', async () => {
  network.setOffline();
  const sessionKey = 'offline-client-id-create-session';

  type CreateWithClientIdOperations = {
    createUser: CollectionOfflineOperationDefinition<
      { value: { name: string } },
      string,
      { itemId: string; name: string },
      unknown,
      { id: string }
    >;
  };

  // The app generates the item id on the client, so the server keeps it:
  // reconciling the creation does not move the item to another key. The
  // server normalizes the name it receives.
  const env = createCollectionStoreTestEnv<
    { name: string },
    CreateWithClientIdOperations
  >(
    {},
    {
      id: 'offline-client-id-create-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            createUser: {
              inputSchema: userPatchSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [input.itemId],
              tempEntity: {
                buildPendingEntity: (input) => ({
                  value: { name: input.name },
                }),
                reconcileServerEntity: (_result, tempId) => ({
                  finalPayload: tempId,
                }),
              },
              execute: async ({ input }) => {
                await env.serverTable.delayedSetItem(input.itemId, {
                  name: input.name.trim(),
                });
                return { id: input.itemId };
              },
            },
          },
        },
      },
    },
  );

  // Create the user offline: the screen shows the local value right away.
  await act(async () => {
    await env.apiStore.performMutation(null, {
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: {
        operation: 'createUser',
        input: { itemId: 'users||client-1', name: '  Ada  ' },
      },
    });
  });

  const hook = renderHook(() => {
    const user = env.apiStore.useItem('users||client-1');

    env.trackItemUI('user', `"${user.data?.value.name ?? '-'}"`);
  });
  await flushAllTimers();

  // Back online: the creation is replayed. With nothing left to sync, the
  // store revalidates the now confirmed item, which shows the server value.
  env.addTimelineComments('beforeNextAction', [
    'back online: the creation is replayed and the item revalidated',
  ]);
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | user      |
    0     | -         | offline:createUser queued
    .     | "  Ada  " | [user] ui-initialized
    1.01s | "  Ada  " | -- back online: the creation is replayed and the item revalidated
    .     | "  Ada  " | offline:createUser replay-started
    2.21s | "  Ada  " | [users||client-1] server-data-changed (value: {"name":"Ada"})
    .     | "  Ada  " | offline:createUser replay-finished
    2.22s | "  Ada  " | 🔴 [users||client-1] >fetch-started
    3.02s | "  Ada  " | 🔴 [users||client-1] <fetch-finished (value: {"name":"Ada"})
    .     | "Ada"     | [user] ui-changed
    "
  `);

  hook.unmount();
});

test('an addition made while a queued addition starts replaying is not lost', async () => {
  network.setOffline();

  const sessionKey = 'offline-accumulation-during-replay-session';
  const storeName = 'offline-accumulation-during-replay-store';
  type CounterOperations = {
    setValue: DocumentOfflineOperationDefinition<
      { value: number },
      { input: { value: number } }
    >;
    addToValue: DocumentOfflineOperationDefinition<
      { value: number },
      { input: { value: number } }
    >;
  };
  const env = createDocumentStoreTestEnv<number, CounterOperations>(0, {
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
          setValue: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            execute: async ({ input }) => {
              await env.serverMock.delayedSetData(input.value, {
                durationMs: 1000,
              });
              return input;
            },
          },
          addToValue: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            // Additions waiting in the queue are combined into one. Merging
            // is async (e.g. it reads app data first), so the replay can
            // pick the queued addition up while it runs.
            accumulation: {
              mergeInput: async ({ existingInput, incomingInput }) => {
                await sleep(200);
                return { value: existingInput.value + incomingInput.value };
              },
            },
            execute: async ({ input }) => {
              await sleep(1000);
              env.serverMock.setData(env.serverMock.current + input.value);
              return input;
            },
          },
        },
      },
    },
  });

  function addToValue(value: number) {
    return env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value += value;
        });
      },
      mutation: async () => {
        await sleep(1000);
        env.serverMock.setData(env.serverMock.current + value);
        return env.serverMock.current;
      },
      offline: { operation: 'addToValue', input: { value } },
    });
  }

  // Offline: the value is set to 100, then 10 is added.
  await env.apiStore.performMutation({
    optimisticUpdate: () => {
      env.apiStore.updateState((draft) => {
        draft.value = 100;
      });
    },
    mutation: async () => {
      await env.serverMock.delayedSetData(100);
      return 100;
    },
    offline: { operation: 'setValue', input: { value: 100 } },
  });
  await addToValue(10);

  // Back online: the queue replays the set first.
  act(() => {
    network.goOnline();
  });
  await advanceTime(900);

  // Right before the set finishes, the user adds 20. It joins the queue
  // behind the queued addition and starts merging into it, but the replay
  // picks that addition up (and sends it) while the merge runs.
  let lateAddition: ReturnType<typeof addToValue> | undefined;
  act(() => {
    lateAddition = addToValue(20);
  });
  await flushAllTimers();
  expect((await lateAddition)?.ok).toBe(true);

  // Every addition reached the server exactly once: 100 + 10 + 20.
  expect(env.serverMock.current).toBe(130);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
});
