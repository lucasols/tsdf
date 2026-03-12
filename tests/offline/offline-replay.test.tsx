import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type CollectionOfflineOperationDefinition,
  type DocumentOfflineOperationDefinition,
  type ListQueryOfflineOperationDefinition,
  localPersistentStorage,
} from '../../src/main';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import {
  collectionCreateInputSchema,
  collectionSchema,
  docConflictSchema,
  docMutationInputSchema,
  docSchema,
  listQueryQueryPayloadSchema,
} from './offlineTestShared';

type CreateUserOperations = {
  createUser: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { name: string },
    unknown,
    { id: string; name: string }
  >;
};

type UpdateValueOperations = {
  updateValue: DocumentOfflineOperationDefinition<
    { value: number },
    { value: number },
    unknown,
    { value: number }
  >;
};

type UpdateValueConflictOperations = {
  updateValue: DocumentOfflineOperationDefinition<
    { value: number },
    { value: number },
    { reason: string },
    { value: number }
  >;
};

type PatchUserOperations = {
  patchUserName: ListQueryOfflineOperationDefinition<
    { id: number; name: string },
    ListQueryParams,
    string,
    { name: string },
    unknown,
    { name: string }
  >;
};

const userPatchSchema = rc_object({ name: rc_string });
const userRowSchema = rc_object({ id: rc_number, name: rc_string });

function getLocalStorageKeys(): string[] {
  const keys: string[] = [];

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key) keys.push(key);
  }

  return keys.sort();
}

describe('offline mode replay and conflict handling', () => {
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

  test('collection offline creates keep durable temp-id metadata and clear after replay finishes', async () => {
    network.setOffline();
    const resolveCreates: Array<
      (result: { id: string; name: string }) => void
    > = [];

    const env = createCollectionStoreTestEnv<
      { name: string },
      CreateUserOperations
    >(
      { 'users||1': { name: 'User 1' } },
      {
        getSessionKey: () => 'offline-temp-id-session',
        testScenario: 'loaded',
        persistentStorage: {
          storeName: 'offline-temp-id-collection',
          adapter: localPersistentStorage,
          schema: collectionSchema,
          payloadSchema: rc_string,
          offlineMode: {
            network: network.config,
            operations: {
              createUser: {
                inputSchema: collectionCreateInputSchema,
                accumulation: {
                  mergeInput: ({ incomingInput }) => incomingInput,
                },
                tempEntity: {
                  createTempId: (input) => `temp:${input.name}`,
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
                    resolveCreates.push(resolve);
                  }),
              },
            },
          },
        },
      },
    );

    await Promise.resolve();
    act(() => {
      network.goOffline();
    });
    await Promise.resolve();

    const queued = await env.apiStore.performMutation('__create__', {
      mutation: () => Promise.resolve({ value: { name: 'Ada' } }),
      offline: { operation: 'createUser', input: { name: 'Ada' } },
    });
    await env.apiStore.performMutation('__create__', {
      mutation: () => Promise.resolve({ value: { name: 'Ada' } }),
      offline: { operation: 'createUser', input: { name: 'Ada' } },
    });

    expect(queued.ok).toBe(true);
    expect(env.apiStore.getOfflineEntities()).toMatchObject([
      { entityKey: 'temp:Ada', pendingMutations: 2, tempId: 'temp:Ada' },
    ]);

    act(() => {
      network.goOnline();
    });
    for (let i = 0; i < 4 && resolveCreates.length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(resolveCreates).toHaveLength(1);
    resolveCreates[0]?.({ id: 'users||ada', name: 'Ada' });
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(resolveCreates).toHaveLength(2);
    resolveCreates[1]?.({ id: 'users||ada-2', name: 'Ada' });
    await flushAllTimers();

    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  });

  test('needs-confirmation entries are confirmed before replay retrying the mutation', async () => {
    network.setOffline();

    const execute = vi
      .fn<
        ({ input }: { input: { value: number } }) => Promise<{ value: number }>
      >()
      .mockRejectedValueOnce(new Error('dispatch failed after send'));
    const confirmRemoteOutcome = vi
      .fn<
        ({
          input,
        }: {
          input: { value: number };
          sessionKey: string;
        }) => Promise<{ type: 'applied' }>
      >()
      .mockResolvedValue({ type: 'applied' });
    const recoveryCheck = vi
      .fn<({ sessionKey }: { sessionKey: string }) => boolean>()
      .mockReturnValue(true);

    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      getSessionKey: () => 'needs-confirmation-session',
      testScenario: 'loaded',
      persistentStorage: {
        storeName: 'needs-confirmation-doc',
        adapter: localPersistentStorage,
        schema: docSchema,
        offlineMode: {
          network: { enabled: true },
          outage: {
            enabled: true,
            classifyFailure: (_error, ctx) =>
              ctx.phase === 'sync' ? 'outage' : 'ignore',
            recoveryCheck,
            recoveryProbe: {
              intervalMs: 50,
              maxIntervalMs: 50,
              backoffMultiplier: 1,
              jitterRatio: 0,
            },
          },
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute,
              confirmRemoteOutcome,
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
    await advanceTime(60);
    await flushAllTimers();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(confirmRemoteOutcome).toHaveBeenCalledTimes(1);
    expect(recoveryCheck).toHaveBeenCalledTimes(1);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  });

  test('needs-confirmation entries retry while outage mode stays disabled', async () => {
    const execute = vi
      .fn<
        ({ input }: { input: { value: number } }) => Promise<{ value: number }>
      >()
      .mockRejectedValueOnce(new Error('dispatch failed after send'));
    const confirmRemoteOutcome = vi
      .fn<
        ({
          input,
        }: {
          input: { value: number };
          sessionKey: string;
        }) => Promise<{ type: 'applied' }>
      >()
      .mockResolvedValue({ type: 'applied' });

    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      getSessionKey: () => 'needs-confirmation-no-outage-session',
      testScenario: 'loaded',
      persistentStorage: {
        storeName: 'needs-confirmation-no-outage-doc',
        adapter: localPersistentStorage,
        schema: docSchema,
        offlineMode: {
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute,
              confirmRemoteOutcome,
            },
          },
        },
      },
    });

    const mutationResult = await env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: () => Promise.resolve(2),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    expect(mutationResult.ok).toBe(true);

    await Promise.resolve();
    await Promise.resolve();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(confirmRemoteOutcome).toHaveBeenCalledTimes(0);

    await advanceTime(300);
    await flushAllTimers();

    expect(confirmRemoteOutcome).toHaveBeenCalledTimes(1);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  });

  test('offline conflicts move out of the queue, surface through selectors, and can be resolved', async () => {
    network.setOffline();
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
              execute: ({ input }) => input,
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: () => ({ reason: 'server-changed' }),
                resolveConflict: () => undefined,
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
    await Promise.resolve();
    await flushAllTimers();

    expect(env.apiStore.getOfflineEntities()).toMatchObject([
      {
        entityKey: 'document',
        hasConflict: true,
        pendingMutations: 0,
        syncState: 'conflict',
      },
    ]);
    expect(env.apiStore.getOfflineConflicts()).toMatchObject([
      { conflict: { reason: 'server-changed' }, operation: 'updateValue' },
    ]);

    const hook = renderHook(() => env.apiStore.useDocument());
    expect(hook.result.current).toMatchInlineSnapshot(`
      data: { value: 2 }
      error: null
      isLoading: '❌'
      isPendingOfflineSync: '❌'
      status: 'success'
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
    });

    expect(env.apiStore.getOfflineConflicts()).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    hook.unmount();
  });

  test('needs-confirmation entries do not accept new accumulation', async () => {
    network.setOffline();
    const execute = vi
      .fn<
        ({ input }: { input: { value: number } }) => Promise<{ value: number }>
      >()
      .mockRejectedValueOnce(new Error('dispatch failed after send'))
      .mockResolvedValue({ value: 3 });

    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      getSessionKey: () => 'offline-needs-confirmation-accumulation-session',
      testScenario: 'loaded',
      persistentStorage: {
        storeName: 'offline-needs-confirmation-accumulation-doc',
        adapter: localPersistentStorage,
        schema: docSchema,
        offlineMode: {
          network: { enabled: true },
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              accumulation: {
                mergeInput: ({ incomingInput }) => incomingInput,
              },
              execute,
              confirmRemoteOutcome: () => ({ type: 'unknown' }),
            },
          },
        },
      },
    });
    await Promise.resolve();

    await env.apiStore.performMutation({
      mutation: () => Promise.resolve(2),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    act(() => {
      network.goOnline();
    });
    await advanceTime(1);
    await Promise.resolve();

    expect(env.apiStore.getOfflineEntities()).toMatchObject([
      {
        entityKey: 'document',
        pendingMutations: 1,
        syncState: 'needs-confirmation',
      },
    ]);

    act(() => {
      network.goOffline();
    });
    await Promise.resolve();

    await env.apiStore.performMutation({
      mutation: () => Promise.resolve(3),
      offline: { operation: 'updateValue', input: { value: 3 } },
    });

    expect(env.apiStore.getOfflineEntities()).toMatchObject([
      { entityKey: 'document', pendingMutations: 2 },
    ]);
  });

  test('needs-confirmation entries keep retrying confirmation while the session stays online', async () => {
    network.setOnline();
    const execute = vi
      .fn<
        ({ input }: { input: { value: number } }) => Promise<{ value: number }>
      >()
      .mockRejectedValueOnce(new Error('dispatch failed after send'));
    const confirmRemoteOutcome = vi
      .fn<
        ({
          input,
        }: {
          input: { value: number };
          sessionKey: string;
        }) => Promise<{ type: 'applied' }>
      >()
      .mockResolvedValue({ type: 'applied' });

    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      getSessionKey: () => 'online-needs-confirmation-retry-session',
      testScenario: 'loaded',
      persistentStorage: {
        storeName: 'online-needs-confirmation-retry-doc',
        adapter: localPersistentStorage,
        schema: docSchema,
        offlineMode: {
          network: network.config,
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute,
              confirmRemoteOutcome,
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

    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(confirmRemoteOutcome).toHaveBeenCalledTimes(0);
    expect(env.apiStore.getOfflineEntities()).toMatchObject([
      {
        entityKey: 'document',
        pendingMutations: 1,
        syncState: 'needs-confirmation',
      },
    ]);

    await advanceTime(300);
    await flushAllTimers();

    expect(confirmRemoteOutcome).toHaveBeenCalledTimes(1);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  });

  test('list-query offline replay forwards the original mutation payload', async () => {
    network.setOffline();
    const execute = vi.fn(
      ({
        input,
        mutationPayload,
      }: {
        input: { name: string };
        mutationPayload?: string | string[];
      }) => {
        if (!mutationPayload || Array.isArray(mutationPayload)) {
          throw new Error('Expected mutationPayload during offline replay');
        }

        env.apiStore.updateItemState(mutationPayload, (item) => ({
          ...item,
          name: input.name,
        }));

        return { name: input.name };
      },
    );

    const env = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      PatchUserOperations
    >(
      { users: [{ id: 1, name: 'Ada' }] },
      {
        getSessionKey: () => 'offline-replay-mutation-payload-session',
        testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
        persistentStorage: {
          storeName: 'offline-replay-mutation-payload',
          adapter: localPersistentStorage,
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offlineMode: {
            network: network.config,
            operations: {
              patchUserName: { inputSchema: userPatchSchema, execute },
            },
          },
        },
      },
    );

    await env.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve({ name: 'Ada offline' }),
      offline: { operation: 'patchUserName', input: { name: 'Ada offline' } },
    });

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]?.mutationPayload).toBe('users||1');
  });

  test('session switches do not leave replayed queue entries in the old namespace', async () => {
    network.setOffline();
    let sessionKey: string | false = 'replay-session-a';
    let resolveReplay: ((result: { value: number }) => void) | undefined;

    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        storeName: 'replay-session-switch-doc',
        adapter: localPersistentStorage,
        schema: docSchema,
        offlineMode: {
          network: network.config,
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: () =>
                new Promise<{ value: number }>((resolve) => {
                  resolveReplay = resolve;
                }),
            },
          },
        },
      },
    });

    await env.apiStore.performMutation({
      mutation: () => Promise.resolve(2),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    expect(
      getLocalStorageKeys().filter((key) =>
        key.startsWith(
          'tsdf.replay-session-a.replay-session-switch-doc.offline.queue.',
        ),
      ),
    ).toHaveLength(1);

    act(() => {
      network.goOnline();
    });
    for (let index = 0; index < 4 && !resolveReplay; index += 1) {
      await Promise.resolve();
    }

    expect(resolveReplay).toBeDefined();
    sessionKey = 'replay-session-b';
    resolveReplay?.({ value: 2 });
    await flushAllTimers();

    expect(
      getLocalStorageKeys().filter((key) =>
        key.startsWith(
          'tsdf.replay-session-a.replay-session-switch-doc.offline.queue.',
        ),
      ),
    ).toMatchInlineSnapshot(`[]`);
  });
});
