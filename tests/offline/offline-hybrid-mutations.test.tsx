import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_boolean, rc_object, rc_string } from 'runcheck';
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
  type UpdateValueConflictOperations,
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
} from './offlineTestShared';

const renameCollectionInputSchema = rc_object({
  id: rc_string,
  name: rc_string,
});
const tempCollectionCreateInputSchema = rc_object({
  name: rc_string,
  shouldCreateTempRef: rc_boolean,
});

const quickRecoveryProbe = {
  intervalMs: 1,
  maxIntervalMs: 1,
  backoffMultiplier: 1,
  jitterRatio: 0,
} as const;

function classifyMutationOutage(error: unknown, phase: string) {
  return (
    phase === 'mutation' &&
    error instanceof Error &&
    error.message === 'offline-fallback'
  );
}

async function waitForMicrotaskCondition(
  condition: () => boolean,
  maxTurns = 20,
): Promise<void> {
  for (let turn = 0; turn < maxTurns && !condition(); turn += 1) {
    await Promise.resolve();
  }
}

type RenameCollectionItemOperations = {
  renameItem: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { id: string; name: string }
  >;
};

type AtomicCollectionBatchOperations = RenameCollectionItemOperations & {
  createItem: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { name: string; shouldCreateTempRef: boolean },
    unknown,
    { id: string; name: string }
  >;
};

describe('hybrid offline mutation execution', () => {
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

  describe('document mutations', () => {
    test('queue immediately when the session is already offline', async () => {
      network.setOffline();
      const sessionKey = 'hybrid-doc-offline-session';
      const storeName = 'hybrid-doc-offline-store';
      const directMutation = vi.fn(() => Promise.resolve(2));
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
      expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);
    });

    test('call the direct mutation while online and skip queueing on success', async () => {
      const sessionKey = 'hybrid-doc-online-session';
      const storeName = 'hybrid-doc-online-store';
      const directMutation = vi.fn(() => Promise.resolve(2));
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
      expect(
        getOfflineQueueEntries(sessionKey, storeName),
      ).toMatchInlineSnapshot(`[]`);
    });

    test('fallback to queueing when the direct failure is classified as offline', async () => {
      const sessionKey = 'hybrid-doc-fallback-session';
      const storeName = 'hybrid-doc-fallback-store';
      const directMutation = vi.fn(() =>
        Promise.reject(new Error('offline-fallback')),
      );
      const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
        getSessionKey: () => sessionKey,
        testScenario: 'loaded',
        persistentStorage: {
          storeName,
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
      expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);
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
        getSessionKey: () => sessionKey,
        testScenario: 'loaded',
        persistentStorage: {
          storeName,
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
      expect(
        getOfflineQueueEntries(sessionKey, storeName),
      ).toMatchInlineSnapshot(`[]`);
    });

    test('online direct mutations that return undefined still revalidate', async () => {
      const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
        getSessionKey: () => 'hybrid-doc-void-online-session',
        testScenario: 'loaded',
        persistentStorage: {
          storeName: 'hybrid-doc-void-online-store',
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

      await act(async () => {
        await advanceTime(1_200);
      });
      await waitForMicrotaskCondition(
        () => documentHook.result.current.data?.value === 2,
      );

      expect(documentHook.result.current.data).toMatchObject({ value: 2 });
      documentHook.unmount();
    });
  });

  describe('collection mutations', () => {
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
          getSessionKey: () => sessionKey,
          testScenario: 'loaded',
          persistentStorage: {
            storeName,
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
      expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);
    });

    test('queue multiple offline operations in array order and replay them in that same order', async () => {
      network.setOffline();
      const sessionKey = 'hybrid-collection-array-session';
      const storeName = 'hybrid-collection-array-store';
      const directMutation = vi.fn(() =>
        Promise.resolve({ value: { name: 'unused' } }),
      );
      const execute = vi.fn(
        ({ input }: { input: { id: string; name: string } }) =>
          Promise.resolve({ value: { name: input.name } }),
      );
      const env = createCollectionStoreTestEnv<
        { name: string },
        RenameCollectionItemOperations
      >(
        { 'users||1': { name: 'Ada' }, 'users||2': { name: 'Grace' } },
        {
          getSessionKey: () => sessionKey,
          testScenario: 'loaded',
          persistentStorage: {
            storeName,
            adapter: 'local-sync',
            schema: collectionSchema,
            payloadSchema: rc_string,
            offlineMode: {
              network: network.config,
              operations: {
                renameItem: {
                  inputSchema: renameCollectionInputSchema,
                  getEntityRefs: ({ input }) => [input.id],
                  execute,
                },
              },
            },
          },
        },
      );

      const result = await env.apiStore.performMutation('users||1', {
        mutation: directMutation,
        offline: [
          {
            operation: 'renameItem',
            input: { id: 'users||1', name: 'Ada queued' },
          },
          {
            operation: 'renameItem',
            input: { id: 'users||2', name: 'Grace queued' },
          },
        ],
      });

      expect(result).toMatchObject({ ok: true, value: { kind: 'queued' } });
      expect(directMutation).not.toHaveBeenCalled();
      expect(
        getOfflineQueueEntries(sessionKey, storeName)
          .map((entry) => {
            const data = getOfflineQueueEntryData(entry);

            return {
              input: data.input,
              operation: data.operation,
              queueOrder: data.queueOrder,
            };
          })
          .sort((left, right) => {
            return Number(left.queueOrder) - Number(right.queueOrder);
          })
          .map(({ queueOrder: _queueOrder, ...entry }) => entry),
      ).toMatchInlineSnapshot(`
        - input: { id: 'users||1', name: 'Ada queued' }
          operation: 'renameItem'
        - input: { id: 'users||2', name: 'Grace queued' }
          operation: 'renameItem'
      `);

      act(() => {
        network.goOnline();
      });
      await advanceTime(250);
      await waitForMicrotaskCondition(() => execute.mock.calls.length === 2);

      expect(execute.mock.calls.map((call) => call[0].input))
        .toMatchInlineSnapshot(`
          - { id: 'users||1', name: 'Ada queued' }
          - { id: 'users||2', name: 'Grace queued' }
        `);
      expect(
        getOfflineQueueEntries(sessionKey, storeName),
      ).toMatchInlineSnapshot(`[]`);
    });

    test('do not partially queue a batch when a later offline descriptor is invalid', async () => {
      network.setOffline();
      const sessionKey = 'hybrid-collection-atomic-session';
      const storeName = 'hybrid-collection-atomic-store';
      const env = createCollectionStoreTestEnv<
        { name: string },
        AtomicCollectionBatchOperations
      >(
        { 'users||1': { name: 'Ada' } },
        {
          getSessionKey: () => sessionKey,
          testScenario: 'loaded',
          persistentStorage: {
            storeName,
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
                createItem: {
                  inputSchema: tempCollectionCreateInputSchema,
                  getEntityRefs: ({ input }) =>
                    input.shouldCreateTempRef ? [`temp:${input.name}`] : [],
                  tempEntity: {
                    buildPendingEntity: (input) => ({
                      value: { name: `pending:${input.name}` },
                    }),
                    reconcileServerEntity: (result) => ({
                      finalPayload: result.id,
                      finalData: { value: { name: result.name } },
                    }),
                  },
                  execute: ({ input }) => ({
                    id: `users||${input.name.toLowerCase()}`,
                    name: input.name,
                  }),
                },
              },
            },
          },
        },
      );

      const result = await env.apiStore.performMutation('users||1', {
        mutation: () => Promise.resolve({ value: { name: 'unused' } }),
        offline: [
          {
            operation: 'renameItem',
            input: { id: 'users||1', name: 'Ada queued' },
          },
          {
            operation: 'createItem',
            input: { name: 'Temp', shouldCreateTempRef: false },
          },
        ],
      });

      expect(result.ok).toBe(false);
      expect(
        getOfflineQueueEntries(sessionKey, storeName),
      ).toMatchInlineSnapshot(`[]`);
      expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
      expect(env.store.state[getCompositeKey('temp:Temp')]).toBeUndefined();
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
          getSessionKey: () => sessionKey,
          testScenario: 'loaded',
          persistentStorage: {
            storeName,
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
      expect(
        getOfflineQueueEntries(sessionKey, storeName),
      ).toMatchInlineSnapshot(`[]`);
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
          getSessionKey: () => sessionKey,
          testScenario: 'loaded',
          persistentStorage: {
            storeName,
            adapter: 'local-sync',
            schema: collectionSchema,
            payloadSchema: rc_string,
            offlineMode: {
              network: network.config,
              outage: {
                enabled: true,
                classifyFailure: (error, ctx) =>
                  classifyMutationOutage(error, ctx.phase)
                    ? 'outage'
                    : 'ignore',
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
      expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);
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
          getSessionKey: () => sessionKey,
          testScenario: 'loaded',
          persistentStorage: {
            storeName,
            adapter: 'local-sync',
            schema: collectionSchema,
            payloadSchema: rc_string,
            offlineMode: {
              network: network.config,
              outage: {
                enabled: true,
                classifyFailure: (error, ctx) =>
                  classifyMutationOutage(error, ctx.phase)
                    ? 'outage'
                    : 'ignore',
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
      expect(
        getOfflineQueueEntries(sessionKey, storeName),
      ).toMatchInlineSnapshot(`[]`);
    });
  });

  describe('list-query mutations', () => {
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
          getSessionKey: () => sessionKey,
          testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
          persistentStorage: {
            storeName,
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
      expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);
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
          getSessionKey: () => sessionKey,
          testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
          persistentStorage: {
            storeName,
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
      expect(
        getOfflineQueueEntries(sessionKey, storeName),
      ).toMatchInlineSnapshot(`[]`);
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
            storeName: 'hybrid-list-void-online-store',
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
          getSessionKey: () => sessionKey,
          testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
          persistentStorage: {
            storeName,
            adapter: 'local-sync',
            schema: userRowSchema,
            itemPayloadSchema: rc_string,
            queryPayloadSchema: listQueryQueryPayloadSchema,
            offlineMode: {
              network: network.config,
              outage: {
                enabled: true,
                classifyFailure: (error, ctx) =>
                  classifyMutationOutage(error, ctx.phase)
                    ? 'outage'
                    : 'ignore',
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
      expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);
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
          getSessionKey: () => sessionKey,
          testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
          persistentStorage: {
            storeName,
            adapter: 'local-sync',
            schema: userRowSchema,
            itemPayloadSchema: rc_string,
            queryPayloadSchema: listQueryQueryPayloadSchema,
            offlineMode: {
              network: network.config,
              outage: {
                enabled: true,
                classifyFailure: (error, ctx) =>
                  classifyMutationOutage(error, ctx.phase)
                    ? 'outage'
                    : 'ignore',
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
      expect(
        getOfflineQueueEntries(sessionKey, storeName),
      ).toMatchInlineSnapshot(`[]`);
    });
  });

  test('fallback queueing does not reapply the optimistic update', async () => {
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      getSessionKey: () => 'hybrid-doc-optimistic-session',
      testScenario: 'loaded',
      persistentStorage: {
        storeName: 'hybrid-doc-optimistic-store',
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
        getSessionKey: () => sessionKey,
        testScenario: 'loaded',
        persistentStorage: {
          storeName,
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

  test('accumulation still merges entries when the queue starts from a fallback', async () => {
    const sessionKey = 'hybrid-accumulation-session';
    const storeName = 'hybrid-accumulation-store';
    const directMutation = vi.fn(() =>
      Promise.reject(new Error('offline-fallback')),
    );
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        storeName,
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
              accumulation: {
                mergeInput: ({ incomingInput }) => incomingInput,
              },
              execute: ({ input }) => input,
            },
          },
        },
      },
    });

    // The first mutation becomes a fallback-queued entry. Once the session is
    // in outage mode, the next mutation should merge into that persisted entry.
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
      mutation: () => Promise.resolve(3),
      offline: { operation: 'updateValue', input: { value: 3 } },
    });

    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(env.store.state.data).toMatchInlineSnapshot(`
      value: 3
    `);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);
    expect(
      getOfflineQueueEntryData(
        getOfflineQueueEntries(sessionKey, storeName)[0]!,
      ),
    ).toMatchObject({ input: { value: 3 } });
  });

  test('conflict handling still works for mutations queued via fallback', async () => {
    const execute = vi.fn(({ input }: { input: { value: number } }) => input);
    const env = createDocumentStoreTestEnv<
      number,
      UpdateValueConflictOperations
    >(1, {
      getSessionKey: () => 'hybrid-conflict-session',
      testScenario: 'loaded',
      persistentStorage: {
        storeName: 'hybrid-conflict-store',
        adapter: 'local-sync',
        schema: docSchema,
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
      },
    });

    // A mutation that first fails online should still enter the normal replay
    // conflict flow once it has been queued by the hybrid fallback.
    const result = await env.apiStore.performMutation({
      mutation: () => Promise.reject(new Error('offline-fallback')),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    expect(result).toMatchObject({ ok: true, value: { kind: 'queued' } });

    await act(async () => {
      await advanceTime(1);
    });
    await waitForMicrotaskCondition(
      () => env.apiStore.getOfflineConflicts().length === 1,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(env.apiStore.getOfflineConflicts()).toMatchObject([
      {
        conflict: { reason: 'server-changed' },
        input: { value: 2 },
        operation: 'updateValue',
      },
    ]);
  });
});
