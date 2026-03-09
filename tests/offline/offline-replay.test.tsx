import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type CollectionOfflineOperationDefinition,
  type DocumentOfflineOperationDefinition,
} from '../../src/main';
import type { DocumentOfflineHelpers } from '../../src/persistentStorage/offline/types';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import {
  collectionCreateInputSchema,
  collectionSchema,
  docConflictSchema,
  docMutationInputSchema,
  docSchema,
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

describe('offline mode replay and conflict handling', () => {
  let online = true;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_INITIAL_TIME);
    online = true;
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => online,
    });
    localStorage.clear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    localStorage.clear();
  });

  test('collection offline creates keep durable temp-id metadata and clear after replay finishes', async () => {
    online = false;
    const getIsOffline = () => !online;
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
          backend: 'localStorage',
          schema: collectionSchema,
          offlineMode: {
            network: { enabled: true, getIsOffline },
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
      window.dispatchEvent(new Event('offline'));
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

    online = true;
    act(() => {
      window.dispatchEvent(new Event('online'));
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
    online = false;

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
          helpers: DocumentOfflineHelpers<{ value: number }>;
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
        backend: 'localStorage',
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

    online = true;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await advanceTime(60);
    await flushAllTimers();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(confirmRemoteOutcome).toHaveBeenCalledTimes(1);
    expect(recoveryCheck).toHaveBeenCalledTimes(1);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  });

  test('offline conflicts move out of the queue, surface through selectors, and can be resolved', async () => {
    online = false;
    const env = createDocumentStoreTestEnv<
      number,
      UpdateValueConflictOperations
    >(1, {
      getSessionKey: () => 'offline-conflict-session',
      testScenario: 'loaded',
      persistentStorage: {
        storeName: 'offline-conflict-doc',
        backend: 'localStorage',
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

    online = true;
    act(() => {
      window.dispatchEvent(new Event('online'));
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
      hasOfflineConflict: '✅'
      isLoading: '❌'
      isPendingOfflineSync: '❌'
      pendingOfflineMutations: 0
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
    expect(hook.result.current.hasOfflineConflict).toBe(false);
    hook.unmount();
  });

  test('needs-confirmation entries do not accept new accumulation', async () => {
    online = false;
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
        backend: 'localStorage',
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

    online = true;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await flushAllTimers();

    expect(env.apiStore.getOfflineEntities()).toMatchObject([
      {
        entityKey: 'document',
        pendingMutations: 1,
        syncState: 'needs-confirmation',
      },
    ]);

    online = false;
    act(() => {
      window.dispatchEvent(new Event('offline'));
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
});
