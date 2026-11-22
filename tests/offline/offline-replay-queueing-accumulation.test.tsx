import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CollectionOfflineOperationDefinition } from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import {
  type CreateUserOperations,
  deleteItemInputSchema,
  getOfflineQueueEntries,
  getOfflineQueueEntryData,
  getSortedQueueSummary,
  type PatchUserOperations,
  type UpdateValueOperations,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  collectionCreateInputSchema,
  collectionSchema,
  docMutationInputSchema,
  docSchema,
  listQueryQueryPayloadSchema,
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

/**
 * A record whose edits carry the permission context they were made with (e.g.
 * a table view or an app block): the server checks the edit against it, so
 * edits with different contexts must reach it as separate requests. Offline
 * edits with the same context are merged.
 */
type UpdateRecordOperations = {
  updateRecord: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { itemId: string; permissionCtx: string; name: string },
    unknown
  >;
  /** A rename from another screen (e.g. a bulk rename), never merged. */
  renameRecord: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { itemId: string; name: string },
    unknown
  >;
};

function createUpdateRecordEnv(sessionKey: string, storeName: string) {
  const execute = vi
    .fn<
      (ctx: {
        input: { itemId: string; permissionCtx: string; name: string };
      }) => Promise<{ value: { name: string } }>
    >()
    .mockImplementation(async ({ input }) => {
      await env.serverTable.delayedUpdateItem(input.itemId, {
        name: input.name,
      });
      return { value: { name: input.name } };
    });

  const env = createCollectionStoreTestEnv<
    { name: string },
    UpdateRecordOperations
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
            updateRecord: {
              inputSchema: rc_object({
                itemId: rc_string,
                permissionCtx: rc_string,
                name: rc_string,
              }),
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              accumulation: {
                // Only edits made with the same permissions are combined
                canMerge: ({ existingInput, incomingInput }) =>
                  existingInput.permissionCtx === incomingInput.permissionCtx,
                mergeInput: ({ incomingInput }) => incomingInput,
              },
              execute,
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateItemState(input.itemId, (draft) => {
                  draft.value.name = input.name;
                });
              },
            },
            renameRecord: {
              inputSchema: rc_object({ itemId: rc_string, name: rc_string }),
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: async ({ input }) => {
                await env.serverTable.delayedUpdateItem(input.itemId, {
                  name: input.name,
                });
                return { value: { name: input.name } };
              },
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

  async function updateRecord(permissionCtx: string, name: string) {
    await env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', (draft) => {
          draft.value.name = name;
        });
      },
      mutation: async () => {
        await env.serverTable.delayedUpdateItem('users||1', { name });
        return { value: { name } };
      },
      offline: {
        operation: 'updateRecord',
        input: { itemId: 'users||1', permissionCtx, name },
      },
    });
  }

  async function renameRecord(name: string) {
    await env.apiStore.performMutation('users||1', {
      mutation: async () => {
        await env.serverTable.delayedUpdateItem('users||1', { name });
        return { value: { name } };
      },
      offline: {
        operation: 'renameRecord',
        input: { itemId: 'users||1', name },
      },
    });
  }

  return { env, execute, updateRecord, renameRecord };
}

test('offline accumulation keeps edits apart when canMerge refuses, and sends them in order', async () => {
  network.setOffline();
  const sessionKey = 'offline-accumulation-can-merge-session';
  const storeName = 'offline-accumulation-can-merge';
  const { env, execute, updateRecord } = createUpdateRecordEnv(
    sessionKey,
    storeName,
  );

  // Two table edits, an app block edit and another table edit of the same
  // record, made offline
  await updateRecord('table', 'Ada table 1');
  await advanceTime(50);
  await updateRecord('table', 'Ada table 2');
  await advanceTime(50);
  await updateRecord('app-block', 'Ada block');
  await advanceTime(50);
  await updateRecord('table', 'Ada table 3');

  // The two consecutive table edits are merged. The app block edit is queued
  // apart, and the last table edit is not merged into the first one, which
  // would send it before the app block edit
  expect(getSortedQueueSummary(sessionKey, storeName)).toMatchInlineSnapshot(`
    - input: { itemId: 'users||1', name: 'Ada table 2', permissionCtx: 'table' }
      operation: 'updateRecord'
    - input: { itemId: 'users||1', name: 'Ada block', permissionCtx: 'app-block' }
      operation: 'updateRecord'
    - input: { itemId: 'users||1', name: 'Ada table 3', permissionCtx: 'table' }
      operation: 'updateRecord'
  `);
  expect(
    env.apiStore
      .getOfflineEntities()
      .map((entity) => pick(entity, ['entityKey', 'pendingMutations'])),
  ).toMatchInlineSnapshot(`
    - entityKey: '"users||1'
      pendingMutations: 3
  `);

  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  // Each entry is a separate request, in the order the edits were made
  expect(execute.mock.calls.map(([ctx]) => ctx.input)).toMatchInlineSnapshot(`
    - { itemId: 'users||1', name: 'Ada table 2', permissionCtx: 'table' }
    - { itemId: 'users||1', name: 'Ada block', permissionCtx: 'app-block' }
    - { itemId: 'users||1', name: 'Ada table 3', permissionCtx: 'table' }
  `);
  expect(pick(env.apiStore.getItemState('users||1'), ['data', 'status']))
    .toMatchInlineSnapshot(`
      data:
        value: { name: 'Ada table 3' }

      status: 'success'
    `);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
});

test('a table edit made together with a refused app block edit is not merged ahead of it, and the server ends with the last edit', async () => {
  network.setOffline();
  const sessionKey = 'offline-accumulation-can-merge-concurrent-session';
  const storeName = 'offline-accumulation-can-merge-concurrent';
  const { env, execute, updateRecord } = createUpdateRecordEnv(
    sessionKey,
    storeName,
  );

  // Offline: a table edit is queued
  await updateRecord('table', 'Ada table 1');
  await advanceTime(50);

  // Then the app sends an app block edit and another table edit of the record
  // at once, without waiting for the first one to be queued (e.g. two blocks
  // saving on the same blur)
  await Promise.all([
    updateRecord('app-block', 'Ada block'),
    updateRecord('table', 'Ada table 2'),
  ]);

  // The app block edit is queued apart. The second table edit is not merged
  // into the first one, which would send it before the app block edit
  expect(getSortedQueueSummary(sessionKey, storeName)).toMatchInlineSnapshot(`
    - input: { itemId: 'users||1', name: 'Ada table 1', permissionCtx: 'table' }
      operation: 'updateRecord'
    - input: { itemId: 'users||1', name: 'Ada block', permissionCtx: 'app-block' }
      operation: 'updateRecord'
    - input: { itemId: 'users||1', name: 'Ada table 2', permissionCtx: 'table' }
      operation: 'updateRecord'
  `);

  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  // Sent in the order the edits were made: the server keeps the last one
  expect(
    execute.mock.calls.map(([ctx]) => ctx.input.name),
  ).toMatchInlineSnapshot(`['Ada table 1', 'Ada block', 'Ada table 2']`);
  expect(env.serverTable.getAll()['users||1']).toMatchInlineSnapshot(
    `name: 'Ada table 2'`,
  );
});

test('an offline edit is not merged into an older edit when another operation changed the record in between, and the server ends with the last edit', async () => {
  network.setOffline();
  const sessionKey = 'offline-accumulation-other-operation-session';
  const storeName = 'offline-accumulation-other-operation';
  const { env, updateRecord, renameRecord } = createUpdateRecordEnv(
    sessionKey,
    storeName,
  );

  // Offline: a table edit, a rename from another screen, then another table
  // edit of the same record
  await updateRecord('table', 'Ada table 1');
  await advanceTime(50);
  await renameRecord('Ada renamed');
  await advanceTime(50);
  await updateRecord('table', 'Ada table 2');

  // The last table edit is queued after the rename instead of being merged
  // into the first table edit, which would send it before the rename and let
  // the rename overwrite it on the server
  expect(getSortedQueueSummary(sessionKey, storeName)).toMatchInlineSnapshot(`
    - input: { itemId: 'users||1', name: 'Ada table 1', permissionCtx: 'table' }
      operation: 'updateRecord'
    - input: { itemId: 'users||1', name: 'Ada renamed' }
      operation: 'renameRecord'
    - input: { itemId: 'users||1', name: 'Ada table 2', permissionCtx: 'table' }
      operation: 'updateRecord'
  `);

  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  // Sent in the order the edits were made: the server keeps the last one
  expect(env.serverTable.getAll()['users||1']).toMatchInlineSnapshot(
    `name: 'Ada table 2'`,
  );
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
