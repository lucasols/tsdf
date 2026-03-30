import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  type CollectionOfflineOperationDefinition,
  type DocumentOfflineOperationDefinition,
  getGlobalOfflineEntities,
  getGlobalOfflineStatus,
  useGlobalOfflineEntities,
  useGlobalOfflineStatus,
} from '../../src/main';
import { readManagedLocalStorageSingleEntryByPayload } from '../../src/persistentStorage/localStorageMetadata';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { userRowSchema } from './offlineReplayTestShared';
import {
  collectionSchema,
  docMutationInputSchema,
  docSchema,
  listQueryQueryPayloadSchema,
  parsePersistedObject,
} from './offlineTestShared';

type DocState = { value: number };
type UpdateValueOperations = {
  updateValue: DocumentOfflineOperationDefinition<
    DocState,
    { input: { value: number } }
  >;
};
type UpdateValueExecuteContext = Parameters<
  UpdateValueOperations['updateValue']['execute']
>[0];
type RenameCollectionItemOperations = {
  renameItem: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { name: string }
  >;
};

function getOfflineQueueEntries(
  sessionKey: string,
  storeName: string,
): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(`tsdf.${sessionKey}.${storeName}.oq.`)) continue;

    const rawEntry = localStorage.getItem(key);
    if (!rawEntry) {
      throw new Error(`Missing persisted offline queue entry for "${key}"`);
    }

    entries.push(parsePersistedObject(rawEntry));
  }

  return entries;
}

describe('offline mode network and session', () => {
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

  test('persistent storage without offlineMode keeps the existing online flow even when the browser reports offline', async () => {
    network.setOffline();

    const sessionKey = 'offline-opt-in-required';
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      getSessionKey: () => sessionKey,
      testScenario: 'idle',
      persistentStorage: { adapter: 'local-sync', schema: docSchema },
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

  test('type safety: document test env requires explicit offline operation typing', () => {
    const plainEnv = createDocumentStoreTestEnv(1);
    const typedEnv = createDocumentStoreTestEnv<number, UpdateValueOperations>(
      1,
    );

    // Type-only assertions: the function is never executed.
    function typeCheck_() {
      void plainEnv.apiStore.performMutation({
        mutation: () => Promise.resolve(2),
        // @ts-expect-error - offline mutations should not be available by default
        offline: { operation: 'updateValue', input: { value: 2 } },
      });

      void plainEnv.apiStore.performMutation({
        mutation: () => Promise.resolve(2),
        // @ts-expect-error - offline mutations should not be available by default
        offline: [
          { operation: 'updateValue', input: { value: 2 } },
          { operation: 'updateValue', input: { value: 3 } },
        ],
      });

      void typedEnv.apiStore.performMutation({
        mutation: () => Promise.resolve(2),
        offline: { operation: 'updateValue', input: { value: 2 } },
      });

      void typedEnv.apiStore.performMutation({
        mutation: () => Promise.resolve(2),
        offline: [
          { operation: 'updateValue', input: { value: 2 } },
          { operation: 'updateValue', input: { value: 3 } },
        ],
      });

      async function queuedOfflineResultType_() {
        const queued = await typedEnv.apiStore.performMutation({
          mutation: () => Promise.resolve(2),
          offline: { operation: 'updateValue', input: { value: 2 } },
        });

        if (queued.ok) {
          const queuedValue:
            | { kind: 'online'; data: number }
            | { kind: 'queued' } = queued.value;
          void queuedValue;

          if (queued.value.kind === 'online') {
            const serverValue: number = queued.value.data;
            void serverValue;
          }

          // @ts-expect-error - queued offline mutations do not always expose a server payload directly
          const serverValue: number = queued.value.data;
          void serverValue;
        }
      }

      async function onlineResultType_() {
        const result = await typedEnv.apiStore.performMutation({
          mutation: () => Promise.resolve(2),
        });

        if (result.ok) {
          const serverValue: number = result.value;
          void serverValue;
        }
      }

      void queuedOfflineResultType_;
      void onlineResultType_;
    }

    void typeCheck_;
    expect(true).toBe(true);
  });

  test('type safety: collection test env requires explicit offline operation typing', () => {
    const initialCollectionData = { 'users||1': { name: 'Ada' } };
    const plainEnv = createCollectionStoreTestEnv(initialCollectionData);
    const typedEnv = createCollectionStoreTestEnv<
      { name: string },
      RenameCollectionItemOperations
    >(initialCollectionData);

    function typeCheck_() {
      void plainEnv.apiStore.performMutation('users||1', {
        mutation: () => Promise.resolve({ value: { name: 'Grace' } }),
        // @ts-expect-error - offline mutations should not be available by default
        offline: { operation: 'renameItem', input: { name: 'Grace' } },
      });

      void plainEnv.apiStore.performMutation('users||1', {
        mutation: () => Promise.resolve({ value: { name: 'Grace' } }),
        // @ts-expect-error - offline mutations should not be available by default
        offline: [
          { operation: 'renameItem', input: { name: 'Grace' } },
          { operation: 'renameItem', input: { name: 'Linus' } },
        ],
      });

      void typedEnv.apiStore.performMutation('users||1', {
        mutation: () => Promise.resolve({ value: { name: 'Grace' } }),
        offline: { operation: 'renameItem', input: { name: 'Grace' } },
      });

      void typedEnv.apiStore.performMutation('users||1', {
        mutation: () => Promise.resolve({ value: { name: 'Grace' } }),
        offline: [
          { operation: 'renameItem', input: { name: 'Grace' } },
          { operation: 'renameItem', input: { name: 'Linus' } },
        ],
      });

      async function queuedOfflineResultType_() {
        const queued = await typedEnv.apiStore.performMutation('users||1', {
          mutation: () => Promise.resolve({ value: { name: 'Grace' } }),
          offline: { operation: 'renameItem', input: { name: 'Grace' } },
        });

        if (queued.ok) {
          const queuedValue:
            | { kind: 'online'; data: { value: { name: string } } }
            | { kind: 'queued' } = queued.value;
          void queuedValue;

          if (queued.value.kind === 'online') {
            const serverValue: { value: { name: string } } = queued.value.data;
            void serverValue;
          }

          // @ts-expect-error - queued offline mutations do not always expose a server payload directly
          const serverValue: { value: { name: string } } = queued.value.data;
          void serverValue;
        }
      }

      async function onlineResultType_() {
        const result = await typedEnv.apiStore.performMutation('users||1', {
          mutation: () => Promise.resolve({ value: { name: 'Grace' } }),
        });

        if (result.ok) {
          const serverValue: { value: { name: string } } = result.value;
          void serverValue;
        }
      }

      void queuedOfflineResultType_;
      void onlineResultType_;
    }

    void typeCheck_;
    expect(true).toBe(true);
  });

  test('stores unregister their previous offline session when the session key becomes unavailable', async () => {
    network.setOffline();

    let currentSessionKey: string | false = 'offline-session-cleanup';
    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: 'offline-session-cleanup-doc',
      getSessionKey: () => currentSessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offlineMode: {
          network: network.config,
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: ({ input }: UpdateValueExecuteContext) => input,
            },
          },
        },
      },
    });

    await act(async () => {
      await env.apiStore.performMutation({
        optimisticUpdate: () => {
          env.apiStore.updateState((draft) => {
            draft.value = 2;
          });
        },
        mutation: () => Promise.resolve(2),
        offline: { operation: 'updateValue', input: { value: 2 } },
      });
    });

    expect(getGlobalOfflineEntities('offline-session-cleanup')).toMatchObject([
      { entityKey: 'document', storeName: 'offline-session-cleanup-doc' },
    ]);

    // Simulate logout so the store no longer belongs to the previous session.
    currentSessionKey = false;

    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    expect(
      getGlobalOfflineEntities('offline-session-cleanup'),
    ).toMatchInlineSnapshot(`[]`);
  });

  test('document offline mutations are queued durably and replay when the browser comes back online', async () => {
    network.setOffline();

    const sessionKey = 'offline-doc-session';
    const storeName = 'offline-doc-store';
    const env = createDocumentStoreTestEnv(1, {
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
              execute: ({ input }: UpdateValueExecuteContext) => {
                env.apiStore.updateState((draft) => {
                  draft.value = input.value;
                });
                return input;
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
        mutation: () => Promise.resolve(2),
        offline: { operation: 'updateValue', input: { value: 2 } },
      });
    });

    expect(mutationResult?.ok).toBe(true);
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
    expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);

    // The optimistic value should stay visible while replay is still pending.
    expect(hook.result.current).toMatchInlineSnapshot(`
      data: { value: 2 }
      error: null
      isLoading: '❌'
      pendingSync: '✅'
      status: 'success'
    `);

    // Once connectivity returns, replay should clear the queue and settle back onto the last confirmed server data.
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
      data: { value: 1 }
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
      .     | "value:2 pending:no"  | ui-changed
      10ms  | "value:2 pending:no"  | 🔴 >fetch-started
      810ms | "value:2 pending:no"  | 🔴 <fetch-finished (value: 1)
      .     | "value:1 pending:no"  | ui-changed
      "
    `);
    hook.unmount();
  });

  test('plain stores do not inherit offline state from other stores in the same session', async () => {
    network.setOffline();
    const sessionKey = 'offline-entity-scope-session';

    const offlineEnv = createDocumentStoreTestEnv<
      number,
      UpdateValueOperations
    >(1, {
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
              execute: ({ input }: UpdateValueExecuteContext) => {
                offlineEnv.apiStore.updateState((draft) => {
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
    expect(documentHook.result.current.pendingSync).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(
        documentHook.result.current,
        'pendingOfflineMutations',
      ),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(
        documentHook.result.current,
        'hasOfflineConflict',
      ),
    ).toBe(false);
    documentHook.unmount();

    const offlineEntitiesHook = renderHook(() =>
      plainEnv.apiStore.useOfflineEntities(),
    );
    expect(offlineEntitiesHook.result.current).toMatchInlineSnapshot(`[]`);
    offlineEntitiesHook.unmount();
  });

  test('offline mutations fail fast when no session key is available', async () => {
    network.setOffline();
    const sessionKey: string | false = false;

    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
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
              execute: ({ input }: UpdateValueExecuteContext) => {
                env.apiStore.updateState((draft) => {
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
    network.setOffline();
    const sessionKey = 'offline-global-hook-session';

    const globalHook = renderHook(() => useGlobalOfflineStatus(sessionKey));
    expect(globalHook.result.current).toMatchObject({
      effectiveOffline: false,
      sessionKey,
    });

    let mutationOk = false;
    await act(async () => {
      const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
        id: 'offline-global-hook-doc',
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
                execute: ({ input }: UpdateValueExecuteContext) => {
                  env.apiStore.updateState((draft) => {
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
    await advanceTime(1010);
    expect(
      readManagedLocalStorageSingleEntryByPayload(
        `tsdf.${sessionKey}.offline-global-hook-doc`,
      ),
    ).toMatchObject({ meta: { o: true } });

    act(() => {
      globalHook.unmount();
    });
  });

  test('offline fetches short-circuit to cached data without clearing the last successful snapshot', async () => {
    network.setOffline();

    const env = createDocumentStoreTestEnv(1, {
      getSessionKey: () => 'offline-read-cache-session',
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offlineMode: { network: network.config, operations: {} },
      },
    });

    await Promise.resolve();
    act(() => {
      network.goOffline();
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
    network.setOffline();

    const env = createDocumentStoreTestEnv(1, {
      getSessionKey: () => 'offline-read-empty-session',
      testScenario: 'idle',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offlineMode: { network: network.config, operations: {} },
      },
    });

    await Promise.resolve();
    act(() => {
      network.goOffline();
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

  test('offline list-query refetches keep the last successful query snapshot visible', async () => {
    const usersQuery = { tableId: 'users' } as const;
    const env = createListQueryStoreTestEnv(
      { users: [{ id: 1, name: 'Ada' }] },
      {
        getSessionKey: () => 'offline-list-query-cache-session',
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offlineMode: { network: network.config, operations: {} },
        },
      },
    );

    const hook = renderHook(() => {
      const query = env.apiStore.useListQuery(usersQuery, {
        itemSelector: (item) => item.name,
      });

      env.trackItemUI('query-status', query.status);
      env.trackItemUI('query-items', query.items.join(', '));

      return query;
    });

    // Start from a real successful query snapshot before forcing the session offline.
    await flushAllTimers();
    expect(pick(hook.result.current, ['items', 'status']))
      .toMatchInlineSnapshot(`
      items: ['Ada']
      status: 'success'
    `);

    // Once offline, a manual refetch should surface the connectivity error without blanking cached items.
    env.clearTimeline();
    act(() => {
      network.goOffline();
    });
    await Promise.resolve();

    env.scheduleFetch('highPriority', usersQuery);
    await flushAllTimers();

    expect(pick(hook.result.current, ['error', 'items', 'status']))
      .toMatchInlineSnapshot(`
      error: { code: 0, id: 'offline', message: 'Offline' }
      items: ['Ada']
      status: 'error'
    `);
    expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
      .toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 1
    `);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | query-items | query-status |
      1.81s | Ada         | success      | -- timeline-cleared
      .     | Ada         | success      | scheduled-fetch-triggered
      1.82s | Ada         | error        | [query-status] ui-changed
      "
    `);

    hook.unmount();
  });

  test('offline list-query mounts without cached data return the normalized connectivity error', async () => {
    const usersQuery = { tableId: 'users' } as const;
    network.setOffline();

    const env = createListQueryStoreTestEnv(
      { users: [{ id: 1, name: 'Ada' }] },
      {
        getSessionKey: () => 'offline-list-query-empty-session',
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offlineMode: { network: network.config, operations: {} },
        },
      },
    );

    const hook = renderHook(() => {
      const query = env.apiStore.useListQuery(usersQuery, {
        itemSelector: (item) => item.name,
      });

      env.trackItemUI('query-status', query.status);
      env.trackItemUI('query-items', query.items.join(', '));

      return query;
    });
    await flushAllTimers();

    expect(pick(hook.result.current, ['error', 'items', 'status']))
      .toMatchInlineSnapshot(`
      error: { code: 0, id: 'offline', message: 'Offline' }
      items: []
      status: 'error'
    `);
    expect(
      env.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time | query-items | query-status |
      0    |             | loading      | [query-status, query-items] ui-initialized
      10ms |             | error        | [query-status] ui-changed
      "
    `);

    hook.unmount();
  });

  test('global offline status is shared across stores in the same session', async () => {
    network.setOffline();
    const sessionKey = 'shared-offline-session';

    createDocumentStoreTestEnv(1, {
      getSessionKey: () => sessionKey,
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offlineMode: { network: { enabled: true }, operations: {} },
      },
    });

    createCollectionStoreTestEnv(
      { 'users||1': { name: 'User 1' } },
      {
        getSessionKey: () => sessionKey,
        persistentStorage: {
          adapter: 'local-sync',
          schema: collectionSchema,
          payloadSchema: rc_string,
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
    network.setOffline();
    const sessionKey = 'shared-offline-entities';
    const pendingReplay = new Promise<{ value: number }>(() => {});

    function createEnv(storeName: string) {
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
                execute: ({ input }: UpdateValueExecuteContext) => {
                  env.apiStore.updateState((draft) => {
                    draft.value = input.value;
                  });
                  return pendingReplay;
                },
              },
            },
          },
        },
      });
      return env;
    }

    const envA = createEnv('offline-doc-a');
    const envB = createEnv('offline-doc-b');
    await Promise.resolve();
    act(() => {
      network.goOffline();
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
