import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_array, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { CollectionOfflineOperationDefinition } from '../../src/main';
import { getGlobalOfflineStatus } from '../../src/persistentStorage/offline/sessionCoordinator';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import {
  type CreateUserOperations,
  getOfflineQueueEntries,
  getOfflineQueueEntryData,
  type PatchUserOperations,
  type UpdateValueOperations,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  classifyMutationOutage,
  collectionCreateInputSchema,
  collectionSchema,
  docMutationInputSchema,
  docSchema,
  quickRecoveryProbe,
  listQueryQueryPayloadSchema,
  waitForMicrotaskCondition,
} from './offlineTestShared';

const renameCollectionInputSchema = rc_object({
  id: rc_string,
  name: rc_string,
});
const batchCollectionCreateInputSchema = rc_array(
  rc_object({ name: rc_string }),
);

function getSingleQueuedMutationData(
  sessionKey: string,
  storeName: string,
): { input: unknown; operation: unknown } {
  const entries = getOfflineQueueEntries(sessionKey, storeName);
  if (entries.length !== 1) {
    throw new Error(
      `Expected exactly one queued mutation for "${sessionKey}/${storeName}" but found ${entries.length}`,
    );
  }

  const data = getOfflineQueueEntryData(entries[0]!);

  return { input: data.input, operation: data.operation };
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

describe('document', () => {
  test('queue immediately when the session is already offline', async () => {
    network.setOffline();
    const sessionKey = 'hybrid-doc-offline-session';
    const storeName = 'hybrid-doc-offline-store';
    const directMutation = vi.fn(() => Promise.resolve(2));
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offlineMode: {
          network: network.config,
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: ({ input }) => input,
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

    expect(result).toMatchObject({ ok: true, value: { kind: 'queued' } });
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
    const directMutation = vi.fn(() => Promise.resolve(2));
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offlineMode: {
          network: network.config,
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: ({ input }) => input,
            },
          },
        },
      },
    });

    // Online offline-enabled mutations should behave like normal direct
    // mutations until a failure is classified as connectivity-related.
    const result = await env.apiStore.performMutation({
      mutation: directMutation,
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { kind: 'online', data: 2 },
    });
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
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offlineMode: {
          network: network.config,
          outage: {
            enabled: true,
            classifyFailure: (error, ctx) =>
              classifyMutationOutage(error, ctx.phase) ? 'outage' : 'ignore',
            recoveryCheck: () => false,
            recoveryProbe: quickRecoveryProbe,
          },
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: ({ input }) => input,
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

    expect(result).toMatchObject({ ok: true, value: { kind: 'queued' } });
    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(getSingleQueuedMutationData(sessionKey, storeName))
      .toMatchInlineSnapshot(`
        input: { value: 2 }
        operation: 'updateValue'
      `);
    expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
      effectiveOffline: true,
      outage: { active: true, enabled: true },
    });
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
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offlineMode: {
          network: network.config,
          outage: {
            enabled: true,
            classifyFailure: (error, ctx) =>
              classifyMutationOutage(error, ctx.phase) ? 'outage' : 'ignore',
            recoveryCheck: () => false,
            recoveryProbe: quickRecoveryProbe,
          },
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: ({ input }) => input,
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
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offlineMode: {
          network: network.config,
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: ({ input }) => input,
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

    const result = await env.apiStore.performMutation({
      mutation: () => Promise.resolve(undefined),
      revalidateOnSuccess: true,
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { kind: 'online', data: undefined },
    });

    await advanceTime(1_200);
    await waitForMicrotaskCondition(
      () => documentHook.result.current.data?.value === 2,
    );

    expect(documentHook.result.current.data).toMatchObject({ value: 2 });
    documentHook.unmount();
  });
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
      Promise.resolve({ value: { name: 'Grace' } }),
    );
    const env = createCollectionStoreTestEnv<
      { name: string },
      RenameCollectionItemOperations
    >(
      { 'users||1': { name: 'Ada' } },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        testScenario: 'loaded',
        persistentStorage: {
          adapter: 'local-sync',
          schema: collectionSchema,
          payloadSchema: rc_string,
          offlineMode: {
            network: network.config,
            operations: {
              renameItem: {
                inputSchema: renameCollectionInputSchema,
                getEntityRefs: ({ input }) => [input.id],
                execute: ({ input }) => ({ value: { name: input.name } }),
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

    expect(result).toMatchObject({ ok: true, value: { kind: 'queued' } });
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
    const createItemsExecute = vi.fn(
      ({ input }: { input: { name: string }[] }) =>
        Promise.resolve(
          input.map((item) => ({
            id: `users||${item.name.toLowerCase()}`,
            name: item.name,
          })),
        ),
    );
    const renameItemExecute = vi.fn(
      ({ input }: { input: { id: string; name: string } }) => {
        env.apiStore.updateItemState(input.id, () => ({
          value: { name: input.name },
        }));

        return Promise.resolve({ value: { name: input.name } });
      },
    );
    const env = createCollectionStoreTestEnv<
      { name: string },
      BatchCollectionCreateOperations
    >(
      { 'users||1': { name: 'Ada' }, 'users||2': { name: 'Grace' } },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        testScenario: 'loaded',
        persistentStorage: {
          adapter: 'local-sync',
          schema: collectionSchema,
          payloadSchema: rc_string,
          offlineMode: {
            network: network.config,
            operations: {
              renameItem: {
                inputSchema: renameCollectionInputSchema,
                getEntityRefs: ({ input }) => [input.id],
                execute: renameItemExecute,
              },
              createItems: {
                inputSchema: batchCollectionCreateInputSchema,
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
      mutation: () => Promise.resolve({ ok: true }),
      offline: {
        operation: 'createItems',
        input: [{ name: 'Ada queued' }, { name: 'Grace queued' }],
      },
    });

    expect(createResult).toMatchObject({ ok: true, value: { kind: 'queued' } });
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
    ).toMatchObject({ value: { name: 'pending:Ada queued' } });
    expect(
      env.store.state[getCompositeKey('temp:Grace queued')]?.data,
    ).toMatchObject({ value: { name: 'pending:Grace queued' } });

    await env.apiStore.performMutation('temp:Ada queued', {
      mutation: () => Promise.resolve({ value: { name: 'Ada rebound' } }),
      offline: {
        operation: 'renameItem',
        input: { id: 'temp:Ada queued', name: 'Ada rebound' },
      },
    });
    await env.apiStore.performMutation('temp:Grace queued', {
      mutation: () => Promise.resolve({ value: { name: 'Grace rebound' } }),
      offline: {
        operation: 'renameItem',
        input: { id: 'temp:Grace queued', name: 'Grace rebound' },
      },
    });

    act(() => {
      network.goOnline();
    });
    await advanceTime(250);
    await waitForMicrotaskCondition(
      () => renameItemExecute.mock.calls.length === 2,
    );

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
    ).toMatchObject({ value: { name: 'Ada rebound' } });
    expect(
      env.store.state[getCompositeKey('users||grace queued')]?.data,
    ).toMatchObject({ value: { name: 'Grace rebound' } });
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
    const env = createCollectionStoreTestEnv<
      { name: string },
      InvalidBatchTempCollectionOperations
    >(
      { 'users||1': { name: 'Ada' } },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        testScenario: 'loaded',
        persistentStorage: {
          adapter: 'local-sync',
          schema: collectionSchema,
          payloadSchema: rc_string,
          offlineMode: {
            network: network.config,
            operations: {
              createItems: {
                inputSchema: batchCollectionCreateInputSchema,
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
                execute: ({ input }) =>
                  input.map((item) => ({
                    id: `users||${item.name.toLowerCase()}`,
                    name: item.name,
                  })),
              },
            },
          },
        },
      },
    );

    const result = await env.apiStore.performMutation(null, {
      mutation: () => Promise.resolve({ value: { name: 'unused' } }),
      offline: {
        operation: 'createItems',
        input: [{ name: 'Temp A' }, { name: 'Temp B' }],
      },
    });

    expect(result.ok).toBe(false);
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
      Promise.resolve({ value: { name: 'Grace' } }),
    );
    const env = createCollectionStoreTestEnv<
      { name: string },
      RenameCollectionItemOperations
    >(
      { 'users||1': { name: 'Ada' } },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        testScenario: 'loaded',
        persistentStorage: {
          adapter: 'local-sync',
          schema: collectionSchema,
          payloadSchema: rc_string,
          offlineMode: {
            network: network.config,
            operations: {
              renameItem: {
                inputSchema: renameCollectionInputSchema,
                getEntityRefs: ({ input }) => [input.id],
                execute: ({ input }) => ({ value: { name: input.name } }),
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

    expect(result).toMatchObject({
      ok: true,
      value: { kind: 'online', data: { value: { name: 'Grace' } } },
    });
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
    const env = createCollectionStoreTestEnv<
      { name: string },
      RenameCollectionItemOperations
    >(
      { 'users||1': { name: 'Ada' } },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        testScenario: 'loaded',
        persistentStorage: {
          adapter: 'local-sync',
          schema: collectionSchema,
          payloadSchema: rc_string,
          offlineMode: {
            network: network.config,
            outage: {
              enabled: true,
              classifyFailure: (error, ctx) =>
                classifyMutationOutage(error, ctx.phase) ? 'outage' : 'ignore',
              recoveryCheck: () => false,
              recoveryProbe: quickRecoveryProbe,
            },
            operations: {
              renameItem: {
                inputSchema: renameCollectionInputSchema,
                getEntityRefs: ({ input }) => [input.id],
                execute: ({ input }) => ({ value: { name: input.name } }),
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

    expect(result).toMatchObject({ ok: true, value: { kind: 'queued' } });
    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(getSingleQueuedMutationData(sessionKey, storeName))
      .toMatchInlineSnapshot(`
        input: { id: 'users||1', name: 'Grace' }
        operation: 'renameItem'
      `);
    expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
      effectiveOffline: true,
    });
  });

  test('preserve the normal error when the direct failure is not connectivity-related', async () => {
    const sessionKey = 'hybrid-collection-error-session';
    const storeName = 'hybrid-collection-error-store';
    const directMutation = vi.fn(() =>
      Promise.reject(new Error('validation-error')),
    );
    const env = createCollectionStoreTestEnv<
      { name: string },
      RenameCollectionItemOperations
    >(
      { 'users||1': { name: 'Ada' } },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        testScenario: 'loaded',
        persistentStorage: {
          adapter: 'local-sync',
          schema: collectionSchema,
          payloadSchema: rc_string,
          offlineMode: {
            network: network.config,
            outage: {
              enabled: true,
              classifyFailure: (error, ctx) =>
                classifyMutationOutage(error, ctx.phase) ? 'outage' : 'ignore',
              recoveryCheck: () => false,
              recoveryProbe: quickRecoveryProbe,
            },
            operations: {
              renameItem: {
                inputSchema: renameCollectionInputSchema,
                getEntityRefs: ({ input }) => [input.id],
                execute: ({ input }) => ({ value: { name: input.name } }),
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
    const directMutation = vi.fn(() => Promise.resolve({ name: 'Grace' }));
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
        testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offlineMode: {
            network: network.config,
            operations: {
              patchUserName: {
                inputSchema: userPatchSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: ({ input }) => ({ name: input.name }),
              },
            },
          },
        },
      },
    );

    const result = await env.apiStore.performMutation('users||1', {
      mutation: directMutation,
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Grace' },
      },
    });

    expect(result).toMatchObject({ ok: true, value: { kind: 'queued' } });
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
    const directMutation = vi.fn(() => Promise.resolve({ name: 'Grace' }));
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
        testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offlineMode: {
            network: network.config,
            operations: {
              patchUserName: {
                inputSchema: userPatchSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: ({ input }) => ({ name: input.name }),
              },
            },
          },
        },
      },
    );

    const result = await env.apiStore.performMutation('users||1', {
      mutation: directMutation,
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Grace' },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { kind: 'online', data: { name: 'Grace' } },
    });
    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
      `[]`,
    );
  });

  test('online direct mutations that return undefined still call onSuccess', async () => {
    const onSuccess = vi.fn();
    const env = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      PatchUserOperations
    >(
      { users: [{ id: 1, name: 'Ada' }] },
      {
        getSessionKey: () => 'hybrid-list-void-online-session',
        testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offlineMode: {
            network: network.config,
            operations: {
              patchUserName: {
                inputSchema: userPatchSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: ({ input }) => ({ name: input.name }),
              },
            },
          },
        },
      },
    );
    const result = await env.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve(undefined),
      onSuccess,
      revalidateOnSuccess: true,
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Grace' },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { kind: 'online', data: undefined },
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(undefined, 'users||1');
  });

  test('fallback to queueing when the direct failure is classified as offline', async () => {
    const sessionKey = 'hybrid-list-fallback-session';
    const storeName = 'hybrid-list-fallback-store';
    const directMutation = vi.fn(() =>
      Promise.reject(new Error('offline-fallback')),
    );
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
        testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offlineMode: {
            network: network.config,
            outage: {
              enabled: true,
              classifyFailure: (error, ctx) =>
                classifyMutationOutage(error, ctx.phase) ? 'outage' : 'ignore',
              recoveryCheck: () => false,
              recoveryProbe: quickRecoveryProbe,
            },
            operations: {
              patchUserName: {
                inputSchema: userPatchSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: ({ input }) => ({ name: input.name }),
              },
            },
          },
        },
      },
    );

    const result = await env.apiStore.performMutation('users||1', {
      mutation: directMutation,
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Grace' },
      },
    });

    expect(result).toMatchObject({ ok: true, value: { kind: 'queued' } });
    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(getSingleQueuedMutationData(sessionKey, storeName))
      .toMatchInlineSnapshot(`
        input: { itemId: 'users||1', name: 'Grace' }
        operation: 'patchUserName'
      `);
    expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
      effectiveOffline: true,
    });
  });

  test('preserve the normal error when the direct failure is not connectivity-related', async () => {
    const sessionKey = 'hybrid-list-error-session';
    const storeName = 'hybrid-list-error-store';
    const directMutation = vi.fn(() =>
      Promise.reject(new Error('validation-error')),
    );
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
        testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offlineMode: {
            network: network.config,
            outage: {
              enabled: true,
              classifyFailure: (error, ctx) =>
                classifyMutationOutage(error, ctx.phase) ? 'outage' : 'ignore',
              recoveryCheck: () => false,
              recoveryProbe: quickRecoveryProbe,
            },
            operations: {
              patchUserName: {
                inputSchema: userPatchSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: ({ input }) => ({ name: input.name }),
              },
            },
          },
        },
      },
    );

    const result = await env.apiStore.performMutation('users||1', {
      mutation: directMutation,
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Grace' },
      },
    });

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
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offlineMode: {
        network: network.config,
        outage: {
          enabled: true,
          classifyFailure: (error, ctx) =>
            classifyMutationOutage(error, ctx.phase) ? 'outage' : 'ignore',
          recoveryCheck: () => false,
          recoveryProbe: quickRecoveryProbe,
        },
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            execute: ({ input }) => input,
          },
        },
      },
    },
  });

  // The optimistic write should happen once and stay visible after the
  // direct request degrades into a queued mutation.
  const result = await env.apiStore.performMutation({
    optimisticUpdate: () => {
      env.apiStore.updateState((draft) => {
        draft.value += 1;
      });
    },
    mutation: () => Promise.reject(new Error('offline-fallback')),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  expect(result).toMatchObject({ ok: true, value: { kind: 'queued' } });
  expect(env.store.state.data).toMatchInlineSnapshot(`
    value: 2
  `);
});

test('fallback queueing still creates and reconciles temp entities', async () => {
  const sessionKey = 'hybrid-temp-entity-session';
  const storeName = 'hybrid-temp-entity-store';
  const directMutation = vi.fn(() =>
    Promise.reject(new Error('offline-fallback')),
  );
  const execute = vi.fn(({ input }: { input: { name: string } }) => ({
    id: 'users||ada',
    name: input.name,
  }));
  const env = createCollectionStoreTestEnv<
    { name: string },
    CreateUserOperations
  >(
    { 'users||1': { name: 'User 1' } },
    {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offlineMode: {
          network: network.config,
          outage: {
            enabled: true,
            classifyFailure: (error, ctx) =>
              classifyMutationOutage(error, ctx.phase) ? 'outage' : 'ignore',
            recoveryCheck: () => true,
            recoveryProbe: quickRecoveryProbe,
          },
          operations: {
            createUser: {
              inputSchema: collectionCreateInputSchema,
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
  const result = await env.apiStore.performMutation('__create__', {
    mutation: directMutation,
    offline: { operation: 'createUser', input: { name: 'Ada' } },
  });

  expect(result).toMatchObject({ ok: true, value: { kind: 'queued' } });
  expect(env.apiStore.getOfflineEntities()).toMatchObject([
    { entityKey: getCompositeKey('temp:Ada'), tempId: 'temp:Ada' },
  ]);
  expect(env.store.state[getCompositeKey('temp:Ada')]?.data).toMatchObject({
    value: { name: 'pending:Ada' },
  });

  await act(async () => {
    await advanceTime(1);
  });
  await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);

  expect(execute).toHaveBeenCalledTimes(1);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(env.store.state[getCompositeKey('temp:Ada')]).toBeNull();
  expect(env.store.state[getCompositeKey('users||ada')]?.data).toMatchObject({
    value: { name: 'Ada' },
  });
});
