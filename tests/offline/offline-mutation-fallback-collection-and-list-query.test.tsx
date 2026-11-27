import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_array, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CollectionOfflineOperationDefinition } from '../../src/main';
import { getGlobalOfflineStatus } from '../../src/persistentStorage/offline/sessionCoordinator';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import { getPayloadKey } from '../../src/utils/getPayloadKey';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  pick,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import {
  type CreateUserOperations,
  getOfflineQueueEntries,
  getSortedQueueSummary,
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
      env.store.state[getPayloadKey('temp:Ada queued')]?.data,
    ).toMatchInlineSnapshot(`value: { name: 'pending:Ada queued' }`);

    expect(
      env.store.state[getPayloadKey('temp:Grace queued')]?.data,
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
      env.store.state[getPayloadKey('users||ada queued')]?.data,
    ).toMatchInlineSnapshot(`value: { name: 'Ada rebound' }`);

    expect(
      env.store.state[getPayloadKey('users||grace queued')]?.data,
    ).toMatchInlineSnapshot(`value: { name: 'Grace rebound' }`);
  });

  test('a debounced rename of an item created offline whose creation is saved during the debounce is sent for the saved item', async () => {
    network.setOffline();
    const sessionKey = 'hybrid-collection-debounced-temp-rename-session';
    const storeName = 'hybrid-collection-debounced-temp-rename-store';
    // The ids the renames sent directly (not replayed) were sent for
    const directRenames: string[] = [];
    // The ids the `onSuccess` of the renames was called with
    const onSuccessPayloads: unknown[] = [];
    const renameItemExecute = vi.fn(
      async ({ input }: { input: { id: string; name: string } }) => {
        await env.serverTable.delayedUpdateItem(input.id, { name: input.name });
        return { value: { name: input.name } };
      },
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
                      tempId: tempIds[index] ?? '',
                      pendingEntity: { value: { name: item.name } },
                    })),
                  reconcileServerEntities: (result, tempIds) =>
                    result.map((item, index) => ({
                      tempId: tempIds[index] ?? '',
                      finalPayload: item.id,
                      finalData: { value: { name: item.name } },
                    })),
                },
                execute: async ({ input }) => {
                  const results = input.map((item) => ({
                    id: 'users||2',
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

    // Grace is created offline under a temp id
    await env.apiStore.performMutation(null, {
      mutation: () => Promise.reject(new Error('never sent directly')),
      offline: { operation: 'createItems', input: [{ name: 'Grace' }] },
    });

    // The user renames Grace in a cell that waits 1.5s for more typing, and
    // reconnects: the creation is sent (1.2s) and saved during the debounce
    const rename = env.apiStore.performMutation('temp:Grace', {
      debounce: { context: 'rename', payload: 'temp:Grace', ms: 1500 },
      optimisticUpdate: () => {
        env.apiStore.updateItemState('temp:Grace', () => ({
          value: { name: 'Grace Hopper' },
        }));
      },
      revalidateOnSuccess: true,
      onSuccess: (_data, itemId) => {
        onSuccessPayloads.push(itemId);
      },
      // Sends the rename for the item it is called with
      mutation: async (itemId) => {
        if (typeof itemId !== 'string') throw new Error('expected an id');
        directRenames.push(itemId);
        await env.serverTable.delayedUpdateItem(itemId, {
          name: 'Grace Hopper',
        });
        return { value: { name: 'Grace Hopper' } };
      },
      offline: {
        operation: 'renameItem',
        input: { id: 'temp:Grace', name: 'Grace Hopper' },
      },
    });
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // Nothing is left to replay, so the rename is sent directly, and for the
    // saved item instead of the temp id the server does not know
    expect((await rename).unwrap()).toMatchInlineSnapshot(`
      data:
        value: { name: 'Grace Hopper' }

      kind: 'online'
    `);
    expect(directRenames).toMatchInlineSnapshot(`['users||2']`);
    expect(renameItemExecute).not.toHaveBeenCalled();
    expect(env.serverTable.get('users||2')).toMatchInlineSnapshot(
      `name: 'Grace Hopper'`,
    );
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

    // The success handling targets the saved item too: `onSuccess` gets its
    // id, and the saved Grace, which shows the name the creation saved, is
    // invalidated so it is refetched with the rename
    expect(onSuccessPayloads).toMatchInlineSnapshot(`['users||2']`);
    expect(
      pick(env.store.state[getPayloadKey('users||2')], [
        'data',
        'refetchOnMount',
      ]),
    ).toMatchInlineSnapshot(`
      data:
        value: { name: 'Grace' }

      refetchOnMount: 'highPriority'
    `);
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
    expect(env.store.state[getPayloadKey('temp:Temp A')]).toBeUndefined();
    expect(env.store.state[getPayloadKey('temp:Temp B')]).toBeUndefined();
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
      inMemoryOnlyMutations: 0
      isForcedOffline: '❌'
      isLeader: '✅'
      isNetworkDetectedOffline: '❌'
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
    // undefined payload plus the item id that was mutated, and the same
    // context as `mutation`.
    expect({ ok: result.ok, value: result.ok ? result.value : null })
      .toMatchInlineSnapshot(`
        ok: '✅'
        value: { kind: 'online' }
      `);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls).toMatchInlineSnapshot(`
      - - undefined
        - 'users||1'
        - offlineInput: { itemId: 'users||1', name: 'Grace' }
          uploads:
            refusedUploadErrorsById: {}
            resolvedRefsById: {}
    `);
  });

  test('an online edit targeting the whole table gets the `offline` input it was called with in `offlineInput`', async () => {
    // The `offlineInput` the edit's `mutation` and `onSuccess` received
    const mutationInputs: unknown[] = [];
    const onSuccessInputs: unknown[] = [];
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
        getSessionKey: () => 'hybrid-list-table-target-session',
        storeManager: createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey: () => 'hybrid-list-table-target-session',
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

    // The app targets the whole users table with a filter, so the edit
    // blocks the table's fetches while it is sent, and sends the request for
    // the row in `offlineInput`
    const result = await resolveAfterAllTimers(
      env.apiStore.performMutation(() => true, {
        mutation: async (_usersTable, { offlineInput }) => {
          mutationInputs.push(offlineInput);
          await env.serverTable.delayedUpdateItem(offlineInput.itemId, {
            name: offlineInput.name,
          });
          return { name: offlineInput.name };
        },
        onSuccess: (_data, _usersTable, { offlineInput }) => {
          onSuccessInputs.push(offlineInput);
        },
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Grace' },
        },
      }),
    );

    // With no item created offline, `offlineInput` is the input of the call
    expect({ ok: result.ok, value: result.ok ? result.value : null })
      .toMatchInlineSnapshot(`
        ok: '✅'

        value:
          data: { name: 'Grace' }
          kind: 'online'
      `);
    expect(mutationInputs).toMatchInlineSnapshot(
      `- { itemId: 'users||1', name: 'Grace' }`,
    );
    expect(onSuccessInputs).toMatchInlineSnapshot(
      `- { itemId: 'users||1', name: 'Grace' }`,
    );
    expect(env.serverTable.get('users||1')).toMatchInlineSnapshot(`
      id: 1
      name: 'Grace'
    `);
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
      inMemoryOnlyMutations: 0
      isForcedOffline: '❌'
      isLeader: '✅'
      isNetworkDetectedOffline: '❌'
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
    env.store.state[getPayloadKey('temp:Ada')]?.data,
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
  expect(env.store.state[getPayloadKey('temp:Ada')]).toBeNull();

  expect(
    env.store.state[getPayloadKey('users||ada')]?.data,
  ).toMatchInlineSnapshot(`value: { name: 'Ada' }`);
});

describe('direct mutation that falls back to the queue after later edits were queued', () => {
  const sessionKey = 'late-fallback-session';
  const storeName = 'late-fallback-store';

  function createEnv(options: { accumulate: boolean }) {
    const mergeInputCalls: Array<{
      existingInput: { id: string; name: string };
      incomingInput: { id: string; name: string };
    }> = [];
    const replayedNames: string[] = [];
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
                accumulation: options.accumulate
                  ? {
                      mergeInput: ({ existingInput, incomingInput }) => {
                        mergeInputCalls.push({ existingInput, incomingInput });
                        // The app keeps the newer edit
                        return incomingInput;
                      },
                    }
                  : undefined,
                execute: ({ input }) => {
                  replayedNames.push(input.name);
                  return env.serverTable
                    .delayedUpdateItem(input.id, { name: input.name })
                    .then(() => ({ value: { name: input.name } }));
                },
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

    return { env, mergeInputCalls, replayedNames };
  }

  /**
   * Edit 1 starts online as a direct request. While it is in flight the
   * connection drops and edit 2 of the same item is queued. Then edit 1 fails
   * with a network error and falls back to the queue.
   */
  async function editWhileTheFirstEditIsInFlight(
    env: ReturnType<typeof createEnv>['env'],
  ) {
    let failEdit1: (error: Error) => void = () => {};
    const edit1 = env.apiStore.performMutation('users||1', {
      mutation: () =>
        new Promise<{ value: { name: string } }>((_, reject) => {
          failEdit1 = reject;
        }),
      offline: {
        operation: 'renameItem',
        input: { id: 'users||1', name: 'Edit 1' },
      },
    });
    await advanceTime(100);

    act(() => {
      network.goOffline();
    });
    await advanceTime(100);

    // Offline, so edit 2 is queued without a direct request
    const edit2 = await env.apiStore.performMutation('users||1', {
      mutation: () => Promise.reject(new Error('never sent directly')),
      offline: {
        operation: 'renameItem',
        input: { id: 'users||1', name: 'Edit 2' },
      },
    });
    await advanceTime(100);

    failEdit1(new Error('Network request failed'));
    const edit1Result = await edit1;

    return {
      edit1: edit1Result.ok ? edit1Result.value : edit1Result.error,
      edit2: edit2.ok ? edit2.value : edit2.error,
    };
  }

  test('with accumulation the late fallback is not merged into the newer edit and replays before it', async () => {
    const { env, mergeInputCalls, replayedNames } = createEnv({
      accumulate: true,
    });

    // Both edits are reported as queued
    expect(await editWhileTheFirstEditIsInFlight(env)).toMatchInlineSnapshot(`
      edit1: { kind: 'queued' }
      edit2: { kind: 'queued' }
    `);

    // Merged into edit 2, edit 1 would be replayed at edit 2's place, after
    // any work queued in between: it keeps its own entry, at the place it had
    // when it was called
    expect(mergeInputCalls).toMatchInlineSnapshot(`[]`);
    expect(getSortedQueueSummary(sessionKey, storeName)).toMatchInlineSnapshot(`
      - input: { id: 'users||1', name: 'Edit 1' }
        operation: 'renameItem'
      - input: { id: 'users||1', name: 'Edit 2' }
        operation: 'renameItem'
    `);

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // The edits reach the server in call order, so the latest one is kept
    expect(replayedNames).toMatchInlineSnapshot(`['Edit 1', 'Edit 2']`);
    expect(env.serverTable.get('users||1')).toMatchInlineSnapshot(
      `name: 'Edit 2'`,
    );
    expect(getSortedQueueSummary(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
  });

  test('without accumulation the late fallback replays before the newer edit', async () => {
    const { env, replayedNames } = createEnv({ accumulate: false });

    expect(await editWhileTheFirstEditIsInFlight(env)).toMatchInlineSnapshot(`
      edit1: { kind: 'queued' }
      edit2: { kind: 'queued' }
    `);

    // Edit 1 keeps the queue position it had when it was called
    expect(getSortedQueueSummary(sessionKey, storeName)).toMatchInlineSnapshot(`
      - input: { id: 'users||1', name: 'Edit 1' }
        operation: 'renameItem'
      - input: { id: 'users||1', name: 'Edit 2' }
        operation: 'renameItem'
    `);

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // The edits reach the server in call order, so the latest one is kept
    expect(replayedNames).toMatchInlineSnapshot(`['Edit 1', 'Edit 2']`);
    expect(env.serverTable.get('users||1')).toMatchInlineSnapshot(
      `name: 'Edit 2'`,
    );
  });

  /** A field patch operation with `accumulation`: the newer edit's fields win */
  function createPatchEnv(networkConfig = network.config) {
    type PatchItemOperations = {
      patchItem: CollectionOfflineOperationDefinition<
        { value: { name: string; city: string } },
        string,
        { id: string; name?: string | undefined; city?: string | undefined }
      >;
    };
    const replayedInputs: Array<{ name?: string; city?: string }> = [];
    const env: ReturnType<
      typeof createCollectionStoreTestEnv<
        { name: string; city: string },
        PatchItemOperations
      >
    > = createCollectionStoreTestEnv<
      { name: string; city: string },
      PatchItemOperations
    >(
      { 'users||1': { name: 'Ada', city: 'Lisbon' } },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        storeManager: createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey: () => sessionKey,
          offlineSession: { network: networkConfig },
        }),
        testScenario: 'loaded',
        persistentStorage: {
          adapter: 'local-sync',
          schema: rc_object({
            value: rc_object({ name: rc_string, city: rc_string }),
          }),
          payloadSchema: rc_string,
          offline: {
            operations: {
              patchItem: {
                inputSchema: rc_object({
                  id: rc_string,
                  name: rc_string.optionalKey(),
                  city: rc_string.optionalKey(),
                }),
                kind: 'update',
                getEntityRefs: ({ input }) => [input.id],
                // A field patch: the newer edit's fields win
                accumulation: {
                  mergeInput: ({ existingInput, incomingInput }) => ({
                    id: incomingInput.id,
                    name: incomingInput.name ?? existingInput.name,
                    city: incomingInput.city ?? existingInput.city,
                  }),
                },
                execute: async ({ input: { id, name, city } }) => {
                  const patch = {
                    ...(name !== undefined && { name }),
                    ...(city !== undefined && { city }),
                  };
                  replayedInputs.push(patch);
                  await env.serverTable.delayedUpdateItem(id, patch);
                },
                onSuccessExecute: ({ input }) => {
                  const item = env.serverTable.get(input.id);
                  if (!item) return;
                  env.apiStore.updateItemState(input.id, () => ({
                    value: { name: item.name, city: item.city },
                  }));
                },
              },
            },
          },
        },
      },
    );

    function startDirectEdit(input: { name?: string; city?: string }) {
      let fail: (error: Error) => void = () => {};
      const result = env.apiStore.performMutation('users||1', {
        mutation: () =>
          new Promise<{ value: { name: string; city: string } }>(
            (_, reject) => {
              fail = reject;
            },
          ),
        offline: {
          operation: 'patchItem',
          input: { id: 'users||1', ...input },
        },
      });
      return { result, fail: (error: Error) => fail(error) };
    }

    return { env, replayedInputs, startDirectEdit };
  }

  test('with accumulation two overlapping direct edits that fall back keep their call order', async () => {
    const { env, replayedInputs, startDirectEdit } = createPatchEnv();

    // Edits 1 and 2 of the name start online as direct requests
    const edit1 = startDirectEdit({ name: 'Edit 1' });
    await advanceTime(100);
    const edit2 = startDirectEdit({ name: 'Edit 2' });
    await advanceTime(100);

    // The connection drops and the user edits another field: it is queued
    act(() => {
      network.goOffline();
    });
    await advanceTime(100);
    await env.apiStore.performMutation('users||1', {
      mutation: () => Promise.reject(new Error('never sent directly')),
      offline: {
        operation: 'patchItem',
        input: { id: 'users||1', city: 'Paris' },
      },
    });
    await advanceTime(100);

    // Both direct requests fail and fall back to the queue, oldest first
    edit1.fail(new Error('Network request failed'));
    await edit1.result;
    edit2.fail(new Error('Network request failed'));
    await edit2.result;

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // Edit 2 was made after edit 1, so its name is the one the server keeps,
    // along with the city edited afterwards
    expect(env.serverTable.get('users||1')).toMatchInlineSnapshot(`
      city: 'Paris'
      name: 'Edit 2'
    `);
    // Edit 2 was merged into edit 1, the entry before it in call order, and
    // the city edit queued while both were in flight kept its own entry after
    // them
    expect(replayedInputs).toMatchInlineSnapshot(`
      - name: 'Edit 2'
      - city: 'Paris'
    `);
    expect(getSortedQueueSummary(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
  });

  test('with accumulation an edit queued while an older direct edit is in flight is not merged before it', async () => {
    const { env, replayedInputs, startDirectEdit } = createPatchEnv();

    // Edits 1 and 2 of the name start online as direct requests
    const edit1 = startDirectEdit({ name: 'Edit 1' });
    await advanceTime(100);
    const edit2 = startDirectEdit({ name: 'Edit 2' });
    await advanceTime(100);

    // The connection drops and edit 1 fails first, falling back to the queue
    act(() => {
      network.goOffline();
    });
    await advanceTime(100);
    edit1.fail(new Error('Network request failed'));
    await edit1.result;

    // While edit 2 is still in flight, the user edits the name again. Merged
    // into edit 1's entry, edit 3 would be replayed at edit 1's place, before
    // edit 2, which would then overwrite it
    await env.apiStore.performMutation('users||1', {
      mutation: () => Promise.reject(new Error('never sent directly')),
      offline: {
        operation: 'patchItem',
        input: { id: 'users||1', name: 'Edit 3' },
      },
    });
    await advanceTime(100);

    // Edit 2 fails later and falls back to the queue
    edit2.fail(new Error('Network request failed'));
    await edit2.result;

    // Edit 3 kept its own entry. Edit 2 was merged into edit 1, the entry
    // before it in call order, so the queue still follows call order
    expect(getSortedQueueSummary(sessionKey, storeName)).toMatchInlineSnapshot(`
      - input: { id: 'users||1', name: 'Edit 2' }
        operation: 'patchItem'
      - input: { id: 'users||1', name: 'Edit 3' }
        operation: 'patchItem'
    `);

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // Edit 3 is the latest edit, so its name is the one the server keeps
    expect(replayedInputs).toMatchInlineSnapshot(`
      - name: 'Edit 2'
      - name: 'Edit 3'
    `);
    expect(env.serverTable.get('users||1')).toMatchInlineSnapshot(`
      city: 'Lisbon'
      name: 'Edit 3'
    `);
    expect(getSortedQueueSummary(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
  });

  test('with accumulation an edit is not merged before an older one still checking the connection', async () => {
    // The app checks the connection with a request whose latency varies, so
    // an older edit's check can settle after a newer edit's one
    const detectionLatencies: number[] = [];
    const { env, replayedInputs } = createPatchEnv({
      enabled: true,
      getIsOffline: () => {
        const latency = detectionLatencies.shift();
        if (latency === undefined) return network.isOffline();
        return new Promise((resolve) => {
          setTimeout(() => resolve(network.isOffline()), latency);
        });
      },
    });

    // Offline, the user edits the name: it is queued
    act(() => {
      network.goOffline();
    });
    await advanceTime(100);
    await env.apiStore.performMutation('users||1', {
      mutation: () => Promise.reject(new Error('never sent directly')),
      offline: {
        operation: 'patchItem',
        input: { id: 'users||1', name: 'Edit 1' },
      },
    });

    // Edit 2's connection check is slow, edit 3's, made right after, is fast,
    // so edit 3 is queued first
    detectionLatencies.push(300, 50);
    const edit2 = env.apiStore.performMutation('users||1', {
      mutation: () => Promise.reject(new Error('never sent directly')),
      offline: {
        operation: 'patchItem',
        input: { id: 'users||1', name: 'Edit 2' },
      },
    });
    await advanceTime(10);
    const edit3 = env.apiStore.performMutation('users||1', {
      mutation: () => Promise.reject(new Error('never sent directly')),
      offline: {
        operation: 'patchItem',
        input: { id: 'users||1', name: 'Edit 3' },
      },
    });
    await advanceTime(400);
    await Promise.all([edit2, edit3]);

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // Edit 3 is the latest edit, so its name is the one the server keeps.
    // Merged into edit 1 before edit 2 was queued, edit 2 would be merged
    // into it afterwards and win
    expect(env.serverTable.get('users||1')).toMatchInlineSnapshot(`
      city: 'Lisbon'
      name: 'Edit 3'
    `);
    // Edit 3 kept its own entry after edit 2, which was merged into edit 1,
    // the entry before it in call order
    expect(replayedInputs).toMatchInlineSnapshot(`
      - name: 'Edit 2'
      - name: 'Edit 3'
    `);
    expect(getSortedQueueSummary(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
  });
});
