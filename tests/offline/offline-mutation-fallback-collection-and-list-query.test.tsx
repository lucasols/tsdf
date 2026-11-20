import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_array, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CollectionOfflineOperationDefinition } from '../../src/main';
import { getGlobalOfflineStatus } from '../../src/persistentStorage/offline/sessionCoordinator';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import {
  type CreateUserOperations,
  getOfflineQueueEntries,
  type PatchUserOperations,
  type UpdateValueOperations,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import { getSingleQueuedMutationData } from './offlineReplayTestShared';
import {
  classifyMutationOutage,
  collectionCreateInputSchema,
  collectionSchema,
  docMutationInputSchema,
  docSchema,
  listQueryQueryPayloadSchema,
  quickRecoveryProbe,
  waitForMicrotaskCondition,
} from './offlineTestShared';

const renameCollectionInputSchema = rc_object({
  id: rc_string,
  name: rc_string,
});

const batchCollectionCreateInputSchema = rc_array(
  rc_object({ name: rc_string }),
);

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

type RenameCollectionItemOperations = {
  renameItem: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { id: string; name: string }
  >;
};

describe('collection', () => {
  test('queue immediately when the session is already offline', async () => {
    network.setOffline();
    const sessionKey = 'hybrid-collection-offline-session';
    const storeName = 'hybrid-collection-offline-store';
    const directMutation = vi.fn(() =>
      env.serverTable
        .delayedUpdateItem('users||1', { name: 'Grace' })
        .then(() => ({ value: { name: 'Grace' } })),
    );
    const env: ReturnType<
      typeof createCollectionStoreTestEnv<
        { name: string },
        RenameCollectionItemOperations
      >
    > = createCollectionStoreTestEnv<
      { name: string },
      RenameCollectionItemOperations
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
              renameItem: {
                inputSchema: renameCollectionInputSchema,
                kind: 'update',
                getEntityRefs: ({ input }) => [input.id],
                execute: ({ input }) =>
                  env.serverTable
                    .delayedUpdateItem(input.id, { name: input.name })
                    .then(() => ({ value: { name: input.name } })),
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateItemState(input.id, () => ({
                    value: { name: input.name },
                  }));
                },
              },
            },
          },
        },
      },
    );

    const result = await env.apiStore.performMutation('users||1', {
      mutation: directMutation,
      offline: {
        operation: 'renameItem',
        input: { id: 'users||1', name: 'Grace' },
      },
    });

    expect({ ok: result.ok, value: result.ok ? result.value : null })
      .toMatchInlineSnapshot(`
        ok: '✅'
        value: { kind: 'queued' }
      `);
    expect(directMutation).not.toHaveBeenCalled();
    expect(getSingleQueuedMutationData(sessionKey, storeName))
      .toMatchInlineSnapshot(`
        input: { id: 'users||1', name: 'Grace' }
        operation: 'renameItem'
      `);
  });

  type BatchCollectionCreateOperations = RenameCollectionItemOperations & {
    createItems: CollectionOfflineOperationDefinition<
      { value: { name: string } },
      string,
      { name: string }[],
      unknown,
      { id: string; name: string }[]
    >;
  };

  test('queue one batch temp-create offline operation and rebind later queued mutations to final payloads', async () => {
    network.setOffline();
    const sessionKey = 'hybrid-collection-batch-temp-session';
    const storeName = 'hybrid-collection-batch-temp-store';
    const applyBatchCreateResults = async (
      results: { id: string; name: string }[],
    ) => {
      for (const result of results) {
        await env.serverTable.delayedSetItem(result.id, { name: result.name });
      }
      return results;
    };
    const applyRenameResult = (input: { id: string; name: string }) =>
      env.serverTable
        .delayedUpdateItem(input.id, { name: input.name })
        .then(() => ({ value: { name: input.name } }));
    const createItemsExecute = vi.fn(
      async ({ input }: { input: { name: string }[] }) => {
        const results = input.map((item) => ({
          id: `users||${item.name.toLowerCase()}`,
          name: item.name,
        }));
        return applyBatchCreateResults(results);
      },
    );
    const renameItemExecute = vi.fn(
      ({ input }: { input: { id: string; name: string } }) =>
        applyRenameResult(input),
    );
    const env: ReturnType<
      typeof createCollectionStoreTestEnv<
        { name: string },
        BatchCollectionCreateOperations
      >
    > = createCollectionStoreTestEnv<
      { name: string },
      BatchCollectionCreateOperations
    >(
      { 'users||1': { name: 'Ada' }, 'users||2': { name: 'Grace' } },
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
              renameItem: {
                inputSchema: renameCollectionInputSchema,
                kind: 'update',
                getEntityRefs: ({ input }) => [input.id],
                execute: renameItemExecute,
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateItemState(input.id, () => ({
                    value: { name: input.name },
                  }));
                },
              },
              createItems: {
                inputSchema: batchCollectionCreateInputSchema,
                kind: 'create',
                getEntityRefs: ({ input }) =>
                  input.map((item) => `temp:${item.name}`),
                tempEntities: {
                  buildPendingEntities: (input, tempIds) =>
                    input.map((item, index) => ({
                      tempId: tempIds[index]!,
                      pendingEntity: {
                        value: { name: `pending:${item.name}` },
                      },
                    })),
                  reconcileServerEntities: (result, tempIds) =>
                    result.map((item, index) => ({
                      tempId: tempIds[index]!,
                      finalPayload: item.id,
                      finalData: { value: { name: item.name } },
                    })),
                },
                execute: createItemsExecute,
              },
            },
          },
        },
      },
    );

    const createResult = await env.apiStore.performMutation(null, {
      mutation: async () => {
        const results = [
          { id: 'users||ada queued', name: 'Ada queued' },
          { id: 'users||grace queued', name: 'Grace queued' },
        ];
        for (const result of results) {
          await env.serverTable.delayedSetItem(result.id, {
            name: result.name,
          });
        }
        return results;
      },
      offline: {
        operation: 'createItems',
        input: [{ name: 'Ada queued' }, { name: 'Grace queued' }],
      },
    });

    expect({
      ok: createResult.ok,
      value: createResult.ok ? createResult.value : null,
    }).toMatchInlineSnapshot(`
      ok: '✅'
      value: { kind: 'queued' }
    `);
    expect(
      env.apiStore
        .getOfflineEntities()
        .map(({ entityKey, tempId }) => ({ entityKey, tempId })),
    ).toMatchInlineSnapshot(`
      - entityKey: '"temp:Ada queued'
        tempId: 'temp:Ada queued'
      - entityKey: '"temp:Grace queued'
        tempId: 'temp:Grace queued'
    `);

    expect(
      env.store.state[getCompositeKey('temp:Ada queued')]?.data,
    ).toMatchInlineSnapshot(`value: { name: 'pending:Ada queued' }`);

    expect(
      env.store.state[getCompositeKey('temp:Grace queued')]?.data,
    ).toMatchInlineSnapshot(`value: { name: 'pending:Grace queued' }`);

    await env.apiStore.performMutation('temp:Ada queued', {
      mutation: () =>
        env.serverTable
          .delayedUpdateItem('temp:Ada queued', { name: 'Ada rebound' })
          .then(() => ({ value: { name: 'Ada rebound' } })),
      offline: {
        operation: 'renameItem',
        input: { id: 'temp:Ada queued', name: 'Ada rebound' },
      },
    });
    await env.apiStore.performMutation('temp:Grace queued', {
      mutation: () =>
        env.serverTable
          .delayedUpdateItem('temp:Grace queued', { name: 'Grace rebound' })
          .then(() => ({ value: { name: 'Grace rebound' } })),
      offline: {
        operation: 'renameItem',
        input: { id: 'temp:Grace queued', name: 'Grace rebound' },
      },
    });

    act(() => {
      network.goOnline();
    });
    await waitForMicrotaskCondition(
      () => createItemsExecute.mock.calls.length === 1,
    );
    await flushAllTimers();

    expect(createItemsExecute).toHaveBeenCalledTimes(1);
    expect(renameItemExecute.mock.calls.map((call) => call[0].input))
      .toMatchInlineSnapshot(`
        - { id: 'users||ada queued', name: 'Ada rebound' }
        - { id: 'users||grace queued', name: 'Grace rebound' }
      `);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );

    expect(
      env.store.state[getCompositeKey('users||ada queued')]?.data,
    ).toMatchInlineSnapshot(`value: { name: 'Ada rebound' }`);

    expect(
      env.store.state[getCompositeKey('users||grace queued')]?.data,
    ).toMatchInlineSnapshot(`value: { name: 'Grace rebound' }`);
  });

  type InvalidBatchTempCollectionOperations = {
    createItems: CollectionOfflineOperationDefinition<
      { value: { name: string } },
      string,
      { name: string }[],
      unknown,
      { id: string; name: string }[]
    >;
  };

  test('do not partially queue or apply batch temp entities when temp metadata is invalid', async () => {
    network.setOffline();
    const sessionKey = 'hybrid-collection-invalid-batch-temp-session';
    const storeName = 'hybrid-collection-invalid-batch-temp-store';
    const env: ReturnType<
      typeof createCollectionStoreTestEnv<
        { name: string },
        InvalidBatchTempCollectionOperations
      >
    > = createCollectionStoreTestEnv<
      { name: string },
      InvalidBatchTempCollectionOperations
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
              createItems: {
                inputSchema: batchCollectionCreateInputSchema,
                kind: 'create',
                getEntityRefs: ({ input }) =>
                  input.map((item) => `temp:${item.name}`),
                tempEntities: {
                  buildPendingEntities: (input, tempIds) => [
                    {
                      tempId: tempIds[0]!,
                      pendingEntity: {
                        value: { name: `pending:${input[0]!.name}` },
                      },
                    },
                  ],
                  reconcileServerEntities: (result, tempIds) =>
                    result.map((item, index) => ({
                      tempId: tempIds[index]!,
                      finalPayload: item.id,
                      finalData: { value: { name: item.name } },
                    })),
                },
                execute: async ({ input }) => {
                  const results = input.map((item) => ({
                    id: `users||${item.name.toLowerCase()}`,
                    name: item.name,
                  }));
                  for (const result of results) {
                    await env.serverTable.delayedSetItem(result.id, {
                      name: result.name,
                    });
                  }
                  return results;
                },
              },
            },
          },
        },
      },
    );

    // This temp-entity definition only returns metadata for the first item in
    // the batch, so the store should reject the mutation atomically.
    const result = await env.apiStore.performMutation(null, {
      mutation: async () => {
        const results = [
          { id: 'users||temp a', name: 'Temp A' },
          { id: 'users||temp b', name: 'Temp B' },
        ];
        for (const item of results) {
          await env.serverTable.delayedSetItem(item.id, { name: item.name });
        }
        return results;
      },
      offline: {
        operation: 'createItems',
        input: [{ name: 'Temp A' }, { name: 'Temp B' }],
      },
    });

    // A malformed temp-entity batch must not leave behind partial queue state
    // or partially-created temp rows.
    expect(result.ok).toBe(false);
    assert(result.ok === false);
    expect(result.error).toMatchInlineSnapshot(`
      Error#:
        message: 'Temp entities for "createItems" must match the resolved temp ids'
        name: 'StoreMutationError'
        kind: 'error'
        code: 500
        id: 'fetch-error'
        cause:
          Error#:
            message: 'Temp entities for "createItems" must match the resolved temp ids'
            name: 'Error'
    `);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    expect(env.store.state[getCompositeKey('temp:Temp A')]).toBeUndefined();
    expect(env.store.state[getCompositeKey('temp:Temp B')]).toBeUndefined();
  });

  test('call the direct mutation while online and skip queueing on success', async () => {
    const sessionKey = 'hybrid-collection-online-session';
    const storeName = 'hybrid-collection-online-store';
    const directMutation = vi.fn(() =>
      env.serverTable
        .delayedUpdateItem('users||1', { name: 'Grace' })
        .then(() => ({ value: { name: 'Grace' } })),
    );
    const env: ReturnType<
      typeof createCollectionStoreTestEnv<
        { name: string },
        RenameCollectionItemOperations
      >
    > = createCollectionStoreTestEnv<
      { name: string },
      RenameCollectionItemOperations
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
              renameItem: {
                inputSchema: renameCollectionInputSchema,
                kind: 'update',
                getEntityRefs: ({ input }) => [input.id],
                execute: ({ input }) =>
                  env.serverTable
                    .delayedUpdateItem(input.id, { name: input.name })
                    .then(() => ({ value: { name: input.name } })),
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateItemState(input.id, () => ({
                    value: { name: input.name },
                  }));
                },
              },
            },
          },
        },
      },
    );

    // While online, offline-enabled mutations should still use the direct
    // mutation path and skip creating replay state.
    const result = await resolveAfterAllTimers(
      env.apiStore.performMutation('users||1', {
        mutation: directMutation,
        offline: {
          operation: 'renameItem',
          input: { id: 'users||1', name: 'Grace' },
        },
      }),
    );

    // The result should stay classified as online and leave the queue empty.
    expect({ ok: result.ok, value: result.ok ? result.value : null })
      .toMatchInlineSnapshot(`
        ok: '✅'

        value:
          data:
            value: { name: 'Grace' }
          kind: 'online'
      `);
    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
  });

  test('fallback to queueing when the direct failure is classified as offline', async () => {
    const sessionKey = 'hybrid-collection-fallback-session';
    const storeName = 'hybrid-collection-fallback-store';
    const directMutation = vi.fn(() =>
      Promise.reject(new Error('offline-fallback')),
    );
    const env: ReturnType<
      typeof createCollectionStoreTestEnv<
        { name: string },
        RenameCollectionItemOperations
      >
    > = createCollectionStoreTestEnv<
      { name: string },
      RenameCollectionItemOperations
    >(
      { 'users||1': { name: 'Ada' } },
      {
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
          schema: collectionSchema,
          payloadSchema: rc_string,
          offline: {
            operations: {
              renameItem: {
                inputSchema: renameCollectionInputSchema,
                kind: 'update',
                getEntityRefs: ({ input }) => [input.id],
                execute: ({ input }) =>
                  env.serverTable
                    .delayedUpdateItem(input.id, { name: input.name })
                    .then(() => ({ value: { name: input.name } })),
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateItemState(input.id, () => ({
                    value: { name: input.name },
                  }));
                },
              },
            },
          },
        },
      },
    );

    // A classified connectivity failure should downgrade the mutation into a
    // queued success instead of bubbling the direct error.
    const result = await env.apiStore.performMutation('users||1', {
      mutation: directMutation,
      offline: {
        operation: 'renameItem',
        input: { id: 'users||1', name: 'Grace' },
      },
    });

    // The queue entry proves replay can happen later, and the session snapshot
    // shows the shared offline mode visible to the rest of the app.
    expect({ ok: result.ok, value: result.ok ? result.value : null })
      .toMatchInlineSnapshot(`
        ok: '✅'
        value: { kind: 'queued' }
      `);
    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(getSingleQueuedMutationData(sessionKey, storeName))
      .toMatchInlineSnapshot(`
        input: { id: 'users||1', name: 'Grace' }
        operation: 'renameItem'
      `);

    expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
      isForcedOffline: '❌'
      isLeader: '✅'
      isOfflineMode: '✅'
      lastFailureAt: 1735689600000
      lastRecoveryCheckAt: null
      network: { active: '❌', enabled: '✅' }
      outage: { active: '✅', enabled: '✅' }
      sessionKey: 'hybrid-collection-fallback-session'
      updatedAt: 1735689600000
    `);
  });

  test('preserve the normal error when the direct failure is not connectivity-related', async () => {
    const sessionKey = 'hybrid-collection-error-session';
    const storeName = 'hybrid-collection-error-store';
    const directMutation = vi.fn(() =>
      Promise.reject(new Error('validation-error')),
    );
    const env: ReturnType<
      typeof createCollectionStoreTestEnv<
        { name: string },
        RenameCollectionItemOperations
      >
    > = createCollectionStoreTestEnv<
      { name: string },
      RenameCollectionItemOperations
    >(
      { 'users||1': { name: 'Ada' } },
      {
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
          schema: collectionSchema,
          payloadSchema: rc_string,
          offline: {
            operations: {
              renameItem: {
                inputSchema: renameCollectionInputSchema,
                kind: 'update',
                getEntityRefs: ({ input }) => [input.id],
                execute: ({ input }) =>
                  env.serverTable
                    .delayedUpdateItem(input.id, { name: input.name })
                    .then(() => ({ value: { name: input.name } })),
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateItemState(input.id, () => ({
                    value: { name: input.name },
                  }));
                },
              },
            },
          },
        },
      },
    );

    // Domain failures should remain visible to callers even when the mutation
    // definition includes offline metadata.
    const result = await env.apiStore.performMutation('users||1', {
      mutation: directMutation,
      offline: {
        operation: 'renameItem',
        input: { id: 'users||1', name: 'Grace' },
      },
    });

    // Because this was not an offline/outage failure, nothing should be
    // persisted for later replay.
    expect(result.ok).toBe(false);
    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
  });
});

describe('list-query', () => {
  test('queue immediately when the session is already offline', async () => {
    network.setOffline();
    const sessionKey = 'hybrid-list-offline-session';
    const storeName = 'hybrid-list-offline-store';
    const directMutation = vi.fn(() =>
      env.serverTable
        .delayedUpdateItem('users||1', { name: 'Grace' })
        .then(() => ({ name: 'Grace' })),
    );
    const env: ReturnType<
      typeof createListQueryStoreTestEnv<
        { id: number; name: string },
        false,
        false,
        PatchUserOperations
      >
    > = createListQueryStoreTestEnv<
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
                execute: ({ input }) =>
                  env.serverTable
                    .delayedUpdateItem(input.itemId, { name: input.name })
                    .then(() => ({ name: input.name })),
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

    // With the session already offline, list-query mutations should queue
    // immediately and avoid touching the direct mutation callback.
    const result = await env.apiStore.performMutation('users||1', {
      mutation: directMutation,
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Grace' },
      },
    });

    // The stored queue payload should match the original list-query mutation
    // input exactly so replay can reconstruct the request.
    expect({ ok: result.ok, value: result.ok ? result.value : null })
      .toMatchInlineSnapshot(`
        ok: '✅'
        value: { kind: 'queued' }
      `);
    expect(directMutation).not.toHaveBeenCalled();
    expect(getSingleQueuedMutationData(sessionKey, storeName))
      .toMatchInlineSnapshot(`
        input: { itemId: 'users||1', name: 'Grace' }
        operation: 'patchUserName'
      `);
  });

  test('call the direct mutation while online and skip queueing on success', async () => {
    const sessionKey = 'hybrid-list-online-session';
    const storeName = 'hybrid-list-online-store';
    const directMutation = vi.fn(() =>
      env.serverTable
        .delayedUpdateItem('users||1', { name: 'Grace' })
        .then(() => ({ name: 'Grace' })),
    );
    const env: ReturnType<
      typeof createListQueryStoreTestEnv<
        { id: number; name: string },
        false,
        false,
        PatchUserOperations
      >
    > = createListQueryStoreTestEnv<
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
                execute: ({ input }) =>
                  env.serverTable
                    .delayedUpdateItem(input.itemId, { name: input.name })
                    .then(() => ({ name: input.name })),
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

    // When connectivity is healthy, list-query mutations should behave like
    // normal direct mutations and never create queued fallback work.
    const result = await resolveAfterAllTimers(
      env.apiStore.performMutation('users||1', {
        mutation: directMutation,
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Grace' },
        },
      }),
    );

    // The success should keep its online result shape and leave the queue empty.
    expect({ ok: result.ok, value: result.ok ? result.value : null })
      .toMatchInlineSnapshot(`
        ok: '✅'

        value:
          data: { name: 'Grace' }
          kind: 'online'
      `);
    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
  });

  test('online direct mutations that return undefined still call onSuccess', async () => {
    const onSuccess = vi.fn();
    const env: ReturnType<
      typeof createListQueryStoreTestEnv<
        { id: number; name: string },
        false,
        false,
        PatchUserOperations
      >
    > = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      PatchUserOperations
    >(
      { users: [{ id: 1, name: 'Ada' }] },
      {
        getSessionKey: () => 'hybrid-list-void-online-session',
        storeManager: createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey: () => 'hybrid-list-void-online-session',
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
                execute: ({ input }) =>
                  env.serverTable
                    .delayedUpdateItem(input.itemId, { name: input.name })
                    .then(() => ({ name: input.name })),
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
    // Even without a payload, the online success path should still notify
    // consumers through the normal onSuccess callback contract.
    const result = await resolveAfterAllTimers(
      env.apiStore.performMutation('users||1', {
        mutation: async () => {
          await env.serverTable.delayedUpdateItem('users||1', {
            name: 'Grace',
          });
        },
        onSuccess,
        revalidateOnSuccess: true,
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Grace' },
        },
      }),
    );

    // The mutation remains an online success, and the callback receives the
    // undefined payload plus the item id that was mutated.
    expect({ ok: result.ok, value: result.ok ? result.value : null })
      .toMatchInlineSnapshot(`
        ok: '✅'
        value: { kind: 'online' }
      `);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(undefined, 'users||1');
  });

  test('fallback to queueing when the direct failure is classified as offline', async () => {
    const sessionKey = 'hybrid-list-fallback-session';
    const storeName = 'hybrid-list-fallback-store';
    const directMutation = vi.fn(() =>
      Promise.reject(new Error('offline-fallback')),
    );
    const env: ReturnType<
      typeof createListQueryStoreTestEnv<
        { id: number; name: string },
        false,
        false,
        PatchUserOperations
      >
    > = createListQueryStoreTestEnv<
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
                execute: ({ input }) =>
                  env.serverTable
                    .delayedUpdateItem(input.itemId, { name: input.name })
                    .then(() => ({ name: input.name })),
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

    // A classified connectivity failure from the direct path should fall back
    // to durable queueing for later replay.
    const result = await env.apiStore.performMutation('users||1', {
      mutation: directMutation,
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Grace' },
      },
    });

    // The queue snapshot and global offline status together show that replay is
    // now possible and the app has entered offline mode.
    expect({ ok: result.ok, value: result.ok ? result.value : null })
      .toMatchInlineSnapshot(`
        ok: '✅'
        value: { kind: 'queued' }
      `);
    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(getSingleQueuedMutationData(sessionKey, storeName))
      .toMatchInlineSnapshot(`
        input: { itemId: 'users||1', name: 'Grace' }
        operation: 'patchUserName'
      `);

    expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
      isForcedOffline: '❌'
      isLeader: '✅'
      isOfflineMode: '✅'
      lastFailureAt: 1735689600000
      lastRecoveryCheckAt: null
      network: { active: '❌', enabled: '✅' }
      outage: { active: '✅', enabled: '✅' }
      sessionKey: 'hybrid-list-fallback-session'
      updatedAt: 1735689600000
    `);
  });

  test('preserve the normal error when the direct failure is not connectivity-related', async () => {
    const sessionKey = 'hybrid-list-error-session';
    const storeName = 'hybrid-list-error-store';
    const directMutation = vi.fn(() =>
      Promise.reject(new Error('validation-error')),
    );
    const env: ReturnType<
      typeof createListQueryStoreTestEnv<
        { id: number; name: string },
        false,
        false,
        PatchUserOperations
      >
    > = createListQueryStoreTestEnv<
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
                execute: ({ input }) =>
                  env.serverTable
                    .delayedUpdateItem(input.itemId, { name: input.name })
                    .then(() => ({ name: input.name })),
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

    // Validation-style failures should stay visible to callers instead of
    // being converted into queued work.
    const result = await env.apiStore.performMutation('users||1', {
      mutation: directMutation,
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Grace' },
      },
    });

    // Since the failure was not connectivity-related, there should be no
    // durable replay artifact left behind.
    expect(result.ok).toBe(false);
    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
  });
});

test('fallback queueing does not reapply the optimistic update', async () => {
  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'hybrid-doc-optimistic-session',
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'hybrid-doc-optimistic-session',
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
  const hook = renderHook(() => {
    const doc = env.apiStore.useDocument();
    env.trackUIChanges(
      `value:${doc.data?.value ?? 'null'} pending:${doc.pendingSync ? 'yes' : 'no'}`,
    );
    return doc;
  });

  await Promise.resolve();

  // The optimistic write should happen once and stay visible after the
  // direct request degrades into a queued mutation.
  const result = await act(async () => {
    return env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value += 1;
        });
      },
      mutation: () => Promise.reject(new Error('offline-fallback')),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });
  });

  // The final document state should show one optimistic increment plus
  // pending-sync state, not a double-applied optimistic update.
  expect({ ok: result.ok, value: result.ok ? result.value : null })
    .toMatchInlineSnapshot(`
      ok: '✅'
      value: { kind: 'queued' }
    `);
  expect(hook.result.current).toMatchInlineSnapshot(`
    data: { value: 2 }
    error: null
    isLoading: '❌'
    pendingSync: '✅'
    status: 'success'
  `);
  expect(env.store.state.data).toMatchInlineSnapshot(`value: 2`);
  // The timeline makes the regression obvious: one value change, then the
  // pending-sync flag when the queued fallback is recorded.
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time | ui                    |
    0    | "value:1 pending:no"  | ui-initialized
    .    | "value:2 pending:no"  | ui-changed
    .    | "value:2 pending:yes" | ui-changed
    .    | "value:2 pending:yes" | offline:updateValue queued
    "
  `);

  hook.unmount();
});

test('fallback queueing still creates and reconciles temp entities', async () => {
  const sessionKey = 'hybrid-temp-entity-session';
  const storeName = 'hybrid-temp-entity-store';
  const directMutation = vi.fn(() =>
    Promise.reject(new Error('offline-fallback')),
  );
  const execute = vi.fn(async ({ input }: { input: { name: string } }) => {
    const result = { id: 'users||ada', name: input.name };
    await env.serverTable.delayedSetItem(result.id, { name: result.name });
    return result;
  });
  const env = createCollectionStoreTestEnv<
    { name: string },
    CreateUserOperations
  >(
    { 'users||1': { name: 'User 1' } },
    {
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
            recoveryCheck: () => true,
            recoveryProbe: quickRecoveryProbe,
          },
        },
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
                  value: { name: `pending:${input.name}` },
                }),
                reconcileServerEntity: (result) => ({
                  finalPayload: result.id,
                  finalData: { value: { name: result.name } },
                }),
              },
              execute,
            },
          },
        },
      },
    },
  );

  // Even though the request started online, the queued fallback still needs
  // to materialize the temp entity so replay can reconcile it later.
  const result = await env.apiStore.performMutation(null, {
    mutation: directMutation,
    offline: { operation: 'createUser', input: { name: 'Ada' } },
  });

  // The fallback should immediately materialize a pending temp entity so the
  // UI can render the optimistic row before replay succeeds.
  expect({ ok: result.ok, value: result.ok ? result.value : null })
    .toMatchInlineSnapshot(`
      ok: '✅'
      value: { kind: 'queued' }
    `);

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: '"temp:Ada'
      entityKind: 'item'
      id: 'hybrid-temp-entity-session:hybrid-temp-entity-store:"temp:Ada'
      kind: 'create'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'hybrid-temp-entity-session'
      storeName: 'hybrid-temp-entity-store'
      storeType: 'collection'
      syncState: 'pending'
      tempId: 'temp:Ada'
      updatedAt: 1735689600000
  `);

  expect(
    env.store.state[getCompositeKey('temp:Ada')]?.data,
  ).toMatchInlineSnapshot(`value: { name: 'pending:Ada' }`);

  // Advancing time lets the recovery probe replay the queued mutation.
  await act(async () => {
    await advanceTime(1);
  });
  await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);
  await flushAllTimers();

  // After replay, the temp entity should be fully reconciled into the final
  // server entity and removed from offline bookkeeping.
  expect(execute).toHaveBeenCalledTimes(1);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(env.store.state[getCompositeKey('temp:Ada')]).toBeNull();

  expect(
    env.store.state[getCompositeKey('users||ada')]?.data,
  ).toMatchInlineSnapshot(`value: { name: 'Ada' }`);
});
