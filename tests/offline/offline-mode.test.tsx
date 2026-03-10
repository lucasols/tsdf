import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type DocumentOfflineOperationDefinition,
  getGlobalOfflineEntities,
  getGlobalOfflineStatus,
  useGlobalOfflineEntities,
  useGlobalOfflineStatus,
} from '../../src/main';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import {
  collectionSchema,
  docMutationInputSchema,
  docSchema,
} from './offlineTestShared';

type DocState = { value: number };
type UpdateValueOperations = {
  updateValue: DocumentOfflineOperationDefinition<
    DocState,
    { value: number },
    unknown,
    { value: number }
  >;
};
type UpdateValueExecuteContext = Parameters<
  UpdateValueOperations['updateValue']['execute']
>[0];

describe('offline mode network and session', () => {
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

  test('persistent storage without offlineMode keeps the existing online flow even when the browser reports offline', async () => {
    online = false;

    const sessionKey = 'offline-opt-in-required';
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      getSessionKey: () => sessionKey,
      testScenario: 'idle',
      persistentStorage: {
        storeName: 'plain-persistence-doc',
        backend: 'localStorage',
        schema: docSchema,
      },
    });

    env.scheduleFetch('highPriority');
    await flushAllTimers();

    expect(env.store.state).toMatchInlineSnapshot(`
      data: { value: 1 }
      error: null
      refetchOnMount: '❌'
      status: 'success'
    `);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    expect(
      pick(getGlobalOfflineStatus(sessionKey), [
        'effectiveMode',
        'effectiveOffline',
        'isLeader',
        'lastFailureAt',
        'lastRecoveryCheckAt',
        'network',
        'outage',
        'sessionKey',
      ]),
    ).toMatchInlineSnapshot(`
      effectiveMode: 'online'
      effectiveOffline: '❌'
      isLeader: '✅'
      lastFailureAt: null
      lastRecoveryCheckAt: null
      network: { active: '❌', enabled: '❌' }
      outage: { active: '❌', enabled: '❌' }
      sessionKey: 'offline-opt-in-required'
    `);
  });

  test('document offline mutations are queued durably and replay when the browser comes back online', async () => {
    online = false;

    const sessionKey = 'offline-doc-session';
    const storeName = 'offline-doc-store';
    const env = createDocumentStoreTestEnv(1, {
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        storeName,
        backend: 'localStorage',
        schema: docSchema,
        offlineMode: {
          network: { enabled: true, getIsOffline: () => !online },
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: ({ input, helpers }: UpdateValueExecuteContext) => {
                helpers.updateState((draft) => {
                  draft.value = input.value;
                });
                return input;
              },
            },
          },
        },
      },
    });

    await Promise.resolve();

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
    expect(env.store.state.data).toMatchInlineSnapshot(`
      value: 2
    `);
    expect(env.apiStore.getOfflineEntities()).toMatchObject([
      {
        entityKey: 'document',
        entityKind: 'document',
        hasConflict: false,
        pendingMutations: 1,
        sessionKey: 'offline-doc-session',
        storeName: 'offline-doc-store',
        storeType: 'document',
      },
    ]);

    const hook = renderHook(() => env.apiStore.useDocument());
    expect(hook.result.current).toMatchInlineSnapshot(`
      data: { value: 2 }
      error: null
      hasOfflineConflict: '❌'
      isLoading: '❌'
      isPendingOfflineSync: '✅'
      pendingOfflineMutations: 1
      status: 'success'
    `);
    hook.unmount();

    online = true;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await advanceTime(250);
    await flushAllTimers();

    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  });

  test('plain stores do not inherit offline state from other stores in the same session', async () => {
    online = false;
    const sessionKey = 'offline-entity-scope-session';

    const offlineEnv = createDocumentStoreTestEnv<
      number,
      UpdateValueOperations
    >(1, {
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        storeName: 'offline-owned-doc',
        backend: 'localStorage',
        schema: docSchema,
        offlineMode: {
          network: { enabled: true, getIsOffline: () => !online },
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: ({ input, helpers }: UpdateValueExecuteContext) => {
                helpers.updateState((draft) => {
                  draft.value = input.value;
                });
                return input;
              },
            },
          },
        },
      },
    });
    const plainEnv = createDocumentStoreTestEnv<number, UpdateValueOperations>(
      10,
      { getSessionKey: () => sessionKey, testScenario: 'loaded' },
    );

    await Promise.resolve();
    await offlineEnv.apiStore.performMutation({
      optimisticUpdate: () => {
        offlineEnv.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: () => Promise.resolve(2),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    const documentHook = renderHook(() => plainEnv.apiStore.useDocument());
    expect(
      pick(documentHook.result.current, [
        'isPendingOfflineSync',
        'pendingOfflineMutations',
        'hasOfflineConflict',
      ]),
    ).toMatchInlineSnapshot(`
      hasOfflineConflict: '❌'
      isPendingOfflineSync: '❌'
      pendingOfflineMutations: 0
    `);
    documentHook.unmount();

    const offlineEntitiesHook = renderHook(() =>
      plainEnv.apiStore.useOfflineEntities(),
    );
    expect(offlineEntitiesHook.result.current).toMatchInlineSnapshot(`[]`);
    offlineEntitiesHook.unmount();
  });

  test('offline mutations fail fast when no session key is available', async () => {
    online = false;
    const sessionKey: string | false = false;

    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        storeName: 'offline-missing-session-doc',
        backend: 'localStorage',
        schema: docSchema,
        offlineMode: {
          network: { enabled: true, getIsOffline: () => !online },
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: ({ input, helpers }: UpdateValueExecuteContext) => {
                helpers.updateState((draft) => {
                  draft.value = input.value;
                });
                return input;
              },
            },
          },
        },
      },
    });

    await Promise.resolve();

    const mutationResult = await env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: () => Promise.resolve(2),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    expect(mutationResult.ok).toBe(false);
    expect(mutationResult.error).toMatchObject({
      id: 'offline-session-unavailable',
    });
    expect(env.store.state.data).toMatchInlineSnapshot(`
      value: 1
    `);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    expect(sessionKey).toBe(false);
  });

  test('global offline hooks can mount before a localStorage-backed store', async () => {
    online = false;
    const sessionKey = 'offline-global-hook-session';

    const globalHook = renderHook(() => useGlobalOfflineStatus(sessionKey));
    expect(globalHook.result.current).toMatchObject({
      effectiveOffline: false,
      sessionKey,
    });

    let mutationOk = false;
    await act(async () => {
      const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
        getSessionKey: () => sessionKey,
        testScenario: 'loaded',
        persistentStorage: {
          storeName: 'offline-global-hook-doc',
          backend: 'localStorage',
          schema: docSchema,
          offlineMode: {
            network: { enabled: true, getIsOffline: () => !online },
            operations: {
              updateValue: {
                inputSchema: docMutationInputSchema,
                execute: ({ input, helpers }: UpdateValueExecuteContext) => {
                  helpers.updateState((draft) => {
                    draft.value = input.value;
                  });
                  return input;
                },
              },
            },
          },
        },
      });

      await Promise.resolve();
      mutationOk = (
        await env.apiStore.performMutation({
          optimisticUpdate: () => {
            env.apiStore.updateState((draft) => {
              draft.value = 2;
            });
          },
          mutation: () => Promise.resolve(2),
          offline: { operation: 'updateValue', input: { value: 2 } },
        })
      ).ok;
      await Promise.resolve();
    });

    expect(mutationOk).toBe(true);
    expect(
      localStorage.getItem(`tsdf.${sessionKey}.__offline__.protected`),
    ).not.toBeNull();

    act(() => {
      globalHook.unmount();
    });
  });

  test('offline fetches short-circuit to cached data without clearing the last successful snapshot', async () => {
    online = false;

    const env = createDocumentStoreTestEnv(1, {
      getSessionKey: () => 'offline-read-cache-session',
      testScenario: 'loaded',
      persistentStorage: {
        storeName: 'offline-read-cache-doc',
        backend: 'localStorage',
        schema: docSchema,
        offlineMode: {
          network: { enabled: true, getIsOffline: () => !online },
          operations: {},
        },
      },
    });

    await Promise.resolve();
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    await Promise.resolve();

    env.scheduleFetch('highPriority');
    await flushAllTimers();

    expect(env.store.state).toMatchInlineSnapshot(`
      data: { value: 1 }
      error: { code: 0, id: 'offline', message: 'Offline' }
      refetchOnMount: '❌'
      status: 'error'
    `);
  });

  test('offline fetches without cached data return the normalized connectivity error', async () => {
    online = false;

    const env = createDocumentStoreTestEnv(1, {
      getSessionKey: () => 'offline-read-empty-session',
      testScenario: 'idle',
      persistentStorage: {
        storeName: 'offline-read-empty-doc',
        backend: 'localStorage',
        schema: docSchema,
        offlineMode: {
          network: { enabled: true, getIsOffline: () => !online },
          operations: {},
        },
      },
    });

    await Promise.resolve();
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    await Promise.resolve();

    env.scheduleFetch('highPriority');
    await flushAllTimers();

    expect(env.store.state).toMatchInlineSnapshot(`
      data: null
      error: { code: 0, id: 'offline', message: 'Offline' }
      refetchOnMount: '❌'
      status: 'error'
    `);
  });

  test('global offline status is shared across stores in the same session', async () => {
    online = false;
    const sessionKey = 'shared-offline-session';

    createDocumentStoreTestEnv(1, {
      getSessionKey: () => sessionKey,
      persistentStorage: {
        storeName: 'shared-doc',
        backend: 'localStorage',
        schema: docSchema,
        offlineMode: { network: { enabled: true }, operations: {} },
      },
    });

    createCollectionStoreTestEnv(
      { 'users||1': { name: 'User 1' } },
      {
        getSessionKey: () => sessionKey,
        persistentStorage: {
          storeName: 'shared-collection',
          backend: 'localStorage',
          schema: collectionSchema,
          offlineMode: { network: { enabled: true }, operations: {} },
        },
      },
    );

    await Promise.resolve();

    expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
      effectiveMode: 'offline'
      effectiveOffline: '✅'
      isLeader: '✅'
      lastFailureAt: null
      lastRecoveryCheckAt: null
      network: { active: '✅', enabled: '✅' }
      outage: { active: '❌', enabled: '❌' }
      sessionKey: 'shared-offline-session'
      updatedAt: 1735689600000
    `);

    const hook = renderHook(() => useGlobalOfflineStatus(sessionKey));
    expect(hook.result.current.effectiveOffline).toBe(true);
    hook.unmount();
  });

  test('global and per-store offline entity selectors aggregate queued work across stores in the same session', async () => {
    online = false;
    const sessionKey = 'shared-offline-entities';
    const getIsOffline = () => !online;
    const pendingReplay = new Promise<{ value: number }>(() => {});

    const createEnv = (storeName: string) =>
      createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
        getSessionKey: () => sessionKey,
        testScenario: 'loaded',
        persistentStorage: {
          storeName,
          backend: 'localStorage',
          schema: docSchema,
          offlineMode: {
            network: { enabled: true, getIsOffline },
            operations: {
              updateValue: {
                inputSchema: docMutationInputSchema,
                execute: ({ input, helpers }: UpdateValueExecuteContext) => {
                  helpers.updateState((draft) => {
                    draft.value = input.value;
                  });
                  return pendingReplay;
                },
              },
            },
          },
        },
      });

    const envA = createEnv('offline-doc-a');
    const envB = createEnv('offline-doc-b');
    await Promise.resolve();
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    await Promise.resolve();

    await envA.apiStore.performMutation({
      optimisticUpdate: () => {
        envA.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: () => Promise.resolve(2),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    await envB.apiStore.performMutation({
      optimisticUpdate: () => {
        envB.apiStore.updateState((draft) => {
          draft.value = 3;
        });
      },
      mutation: () => Promise.resolve(3),
      offline: { operation: 'updateValue', input: { value: 3 } },
    });

    expect(getGlobalOfflineEntities(sessionKey)).toMatchObject([
      {
        entityKey: 'document',
        pendingMutations: 1,
        storeName: 'offline-doc-a',
      },
      {
        entityKey: 'document',
        pendingMutations: 1,
        storeName: 'offline-doc-b',
      },
    ]);

    const globalHook = renderHook(() => useGlobalOfflineEntities(sessionKey));
    expect(globalHook.result.current).toHaveLength(2);
    globalHook.unmount();

    const storeHook = renderHook(() => envA.apiStore.useOfflineEntities());
    expect(storeHook.result.current).toMatchObject([
      {
        entityKey: 'document',
        pendingMutations: 1,
        storeName: 'offline-doc-a',
      },
    ]);
    storeHook.unmount();
  });
});
