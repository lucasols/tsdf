import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  CollectionOfflineOperationDefinition,
  ListQueryOfflineOperationDefinition,
} from '../../src/main';
import { createOfflineSession } from '../../src/main';
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
  type CreateListQueryUserOperations,
  type PatchUserOperations,
  type UpdateValueExecuteContext,
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

let network = createOfflineNetworkMock();
const staleInvalidationFetchDurationMs = 810;
const replaySettleDurationMs = 2_000;

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

const deleteItemInputSchema = rc_object({ itemId: rc_string });

function reconnectAndInvalidate(invalidate: () => void) {
  act(() => {
    network.goOnline();
    invalidate();
  });
}

async function waitForStaleInvalidationToFinish() {
  await advanceTime(staleInvalidationFetchDurationMs);
}

async function waitForReplayToSettle() {
  await advanceTime(replaySettleDurationMs);
  await flushAllTimers();
}

function summarizeOfflineEntitySyncState(
  entities: Array<{
    entityKey?: string;
    pendingMutations?: number;
    requiresResolution: boolean;
    syncState: string;
  }>,
) {
  return entities.map(
    ({ entityKey, pendingMutations, requiresResolution, syncState }) => ({
      ...(entityKey === undefined ? {} : { entityKey }),
      ...(pendingMutations === undefined || pendingMutations === 0
        ? {}
        : { pendingMutations }),
      requiresResolution,
      syncState,
    }),
  );
}

describe('document overlays', () => {
  test('document invalidation keeps pending optimistic data visible until replay settles', async () => {
    network.setOffline();

    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: 'offline-doc-overlay-store',
      getSessionKey: () => 'offline-doc-overlay-session',
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => 'offline-doc-overlay-session',
            config: { network: network.config },
          }),
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: ({ input }: UpdateValueExecuteContext) =>
                new Promise((resolve) => {
                  setTimeout(() => {
                    env.apiStore.updateState((draft) => {
                      draft.value = input.value;
                    });
                    resolve(input);
                  }, 2000);
                }),
            },
          },
        },
      },
    });

    const hook = renderHook(() => env.apiStore.useDocument());
    await Promise.resolve();

    // Queue an optimistic document edit while the browser is offline.
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

    expect(hook.result.current).toMatchInlineSnapshot(`
      data: { value: 2 }
      error: null
      isLoading: '❌'
      pendingSync: '✅'
      status: 'success'
    `);

    // Let a stale refetch land before the queued replay finishes.
    reconnectAndInvalidate(() => {
      env.scheduleFetch('highPriority');
    });
    await waitForStaleInvalidationToFinish();

    expect(hook.result.current).toMatchInlineSnapshot(`
      data: { value: 2 }
      error: null
      isLoading: '❌'
      pendingSync: '✅'
      status: 'success'
    `);

    // Once replay settles, the optimistic overlay should no longer be needed.
    await waitForReplayToSettle();

    expect(hook.result.current).toMatchInlineSnapshot(`
      data: { value: 2 }
      error: null
      isLoading: '❌'
      pendingSync: '❌'
      status: 'success'
    `);

    hook.unmount();
  });

  test('document offline overlay stops deriving once replay requires manual resolution', async () => {
    network.setOffline();

    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: 'offline-doc-overlay-resolution-store',
      getSessionKey: () => 'offline-doc-overlay-resolution-session',
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => 'offline-doc-overlay-resolution-session',
            config: {
              network: network.config,
              replayRetry: { maxFailures: 1, intervalMs: 1 },
            },
          }),
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute: () => {
                throw new Error('Replay failed');
              },
            },
          },
        },
      },
    });

    const hook = renderHook(() => env.apiStore.useDocument());
    await Promise.resolve();

    // Queue an optimistic document edit that will later fail during replay.
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

    // Reconnect and let replay transition the queued mutation into manual resolution.
    reconnectAndInvalidate(() => {
      env.scheduleFetch('highPriority');
    });
    await flushAllTimers();

    expect(hook.result.current).toMatchInlineSnapshot(`
      data: { value: 1 }
      error: null
      isLoading: '❌'
      pendingSync: '❌'
      status: 'success'
    `);
    expect(summarizeOfflineEntitySyncState(env.apiStore.getOfflineEntities()))
      .toMatchInlineSnapshot(`
        - entityKey: 'document'
          requiresResolution: '✅'
          syncState: 'resolution-required'
      `);

    hook.unmount();
  });
});

type RenameCollectionItemOperations = {
  renameItem: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { name: string }
  >;
};

type DeleteCollectionItemOperations = {
  deleteItem: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { itemId: string }
  >;
};

describe('collection overlays', () => {
  test('collection invalidation keeps pending optimistic data visible until replay settles', async () => {
    network.setOffline();

    const env = createCollectionStoreTestEnv<
      { name: string },
      RenameCollectionItemOperations
    >(
      { 'users||1': { name: 'Ada' } },
      {
        id: 'offline-collection-overlay-store',
        getSessionKey: () => 'offline-collection-overlay-session',
        testScenario: 'loaded',
        persistentStorage: {
          adapter: 'local-sync',
          schema: collectionSchema,
          payloadSchema: rc_string,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => 'offline-collection-overlay-session',
              config: { network: network.config },
            }),
            operations: {
              renameItem: {
                inputSchema: collectionCreateInputSchema,
                getEntityRefs: () => ['users||1'],
                execute: ({ input }) =>
                  new Promise((resolve) => {
                    setTimeout(() => {
                      env.apiStore.updateItemState('users||1', (draft) => {
                        draft.value.name = input.name;
                      });
                      resolve({ value: { name: input.name } });
                    }, 2000);
                  }),
              },
            },
          },
        },
      },
    );

    const hook = renderHook(() =>
      env.apiStore.useItem('users||1', {
        selector: (item) => item?.value.name ?? null,
      }),
    );
    await Promise.resolve();

    // Queue an optimistic rename while the item is offline-visible.
    await act(async () => {
      await env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('users||1', (draft) => {
            draft.value.name = 'Ada pending';
          });
        },
        mutation: () => Promise.resolve({ value: { name: 'Ada replayed' } }),
        offline: { operation: 'renameItem', input: { name: 'Ada replayed' } },
      });
    });

    expect(hook.result.current).toMatchInlineSnapshot(`
      data: 'Ada pending'
      error: null
      isLoading: '❌'
      itemStateKey: '"users||1'
      payload: 'users||1'
      pendingSync: '✅'
      status: 'success'
    `);

    // A refetch finishing first should not replace the optimistic item overlay.
    reconnectAndInvalidate(() => {
      env.scheduleFetch('highPriority', 'users||1');
    });
    await waitForStaleInvalidationToFinish();

    expect(hook.result.current).toMatchInlineSnapshot(`
      data: 'Ada pending'
      error: null
      isLoading: '❌'
      itemStateKey: '"users||1'
      payload: 'users||1'
      pendingSync: '✅'
      status: 'success'
    `);

    // Once replay finishes, the overlay can collapse into the real item state.
    await waitForReplayToSettle();

    expect(hook.result.current).toMatchInlineSnapshot(`
      data: 'Ada replayed'
      error: null
      isLoading: '❌'
      itemStateKey: '"users||1'
      payload: 'users||1'
      pendingSync: '❌'
      status: 'success'
    `);

    hook.unmount();
  });

  test('collection invalidation keeps pending deletes hidden until replay settles', async () => {
    network.setOffline();

    const env = createCollectionStoreTestEnv<
      { name: string },
      DeleteCollectionItemOperations
    >(
      { 'users||1': { name: 'Ada' } },
      {
        id: 'offline-collection-delete-overlay-store',
        getSessionKey: () => 'offline-collection-delete-overlay-session',
        testScenario: 'loaded',
        persistentStorage: {
          adapter: 'local-sync',
          schema: collectionSchema,
          payloadSchema: rc_string,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => 'offline-collection-delete-overlay-session',
              config: { network: network.config },
            }),
            operations: {
              deleteItem: {
                inputSchema: deleteItemInputSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: ({ input }) =>
                  new Promise((resolve) => {
                    setTimeout(() => {
                      env.apiStore.deleteItemState(input.itemId);
                      resolve(undefined);
                    }, 2000);
                  }),
              },
            },
          },
        },
      },
    );

    const hook = renderHook(() =>
      env.apiStore.useItem('users||1', {
        selector: (item) => item?.value.name ?? null,
      }),
    );
    await Promise.resolve();

    // Queue a delete so the item disappears immediately from the UI.
    await act(async () => {
      await env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.deleteItemState('users||1');
        },
        mutation: () => Promise.resolve(undefined),
        offline: { operation: 'deleteItem', input: { itemId: 'users||1' } },
      });
    });

    expect(hook.result.current).toMatchInlineSnapshot(`
      data: null
      error: null
      isLoading: '❌'
      itemStateKey: '"users||1'
      payload: 'users||1'
      pendingSync: '✅'
      status: 'deleted'
    `);

    // A stale item refetch should not resurrect the deleted entry before replay settles.
    reconnectAndInvalidate(() => {
      env.scheduleFetch('highPriority', 'users||1');
    });
    await waitForStaleInvalidationToFinish();

    expect(hook.result.current).toMatchInlineSnapshot(`
      data: null
      error: null
      isLoading: '❌'
      itemStateKey: '"users||1'
      payload: 'users||1'
      pendingSync: '✅'
      status: 'deleted'
    `);

    // Replay completion should only clear the sync metadata, not change the deleted UI.
    await waitForReplayToSettle();

    expect(hook.result.current).toMatchInlineSnapshot(`
      data: null
      error: null
      isLoading: '❌'
      itemStateKey: '"users||1'
      payload: 'users||1'
      pendingSync: '❌'
      status: 'deleted'
    `);

    hook.unmount();
  });

  test('collection offline overlay stops deriving once replay requires manual resolution', async () => {
    network.setOffline();

    const env = createCollectionStoreTestEnv<
      { name: string },
      RenameCollectionItemOperations
    >(
      { 'users||1': { name: 'Ada' } },
      {
        id: 'offline-collection-overlay-resolution-store',
        getSessionKey: () => 'offline-collection-overlay-resolution-session',
        testScenario: 'loaded',
        persistentStorage: {
          adapter: 'local-sync',
          schema: collectionSchema,
          payloadSchema: rc_string,
          offline: {
            session: createOfflineSession({
              getSessionKey: () =>
                'offline-collection-overlay-resolution-session',
              config: {
                network: network.config,
                replayRetry: { maxFailures: 1, intervalMs: 1 },
              },
            }),
            operations: {
              renameItem: {
                inputSchema: collectionCreateInputSchema,
                getEntityRefs: () => ['users||1'],
                execute: () => {
                  throw new Error('Replay failed');
                },
              },
            },
          },
        },
      },
    );

    const hook = renderHook(() =>
      env.apiStore.useItem('users||1', {
        selector: (item) => item?.value.name ?? null,
      }),
    );
    await Promise.resolve();

    // Queue an optimistic rename that replay will reject into manual resolution.
    await act(async () => {
      await env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('users||1', (draft) => {
            draft.value.name = 'Ada pending';
          });
        },
        mutation: () => Promise.resolve({ value: { name: 'Ada replayed' } }),
        offline: { operation: 'renameItem', input: { name: 'Ada replayed' } },
      });
    });

    // Reconnect and let replay replace the derived overlay with the persisted server value.
    reconnectAndInvalidate(() => {
      env.scheduleFetch('highPriority', 'users||1');
    });
    await flushAllTimers();

    expect(hook.result.current).toMatchInlineSnapshot(`
      data: 'Ada'
      error: null
      isLoading: '❌'
      itemStateKey: '"users||1'
      payload: 'users||1'
      pendingSync: '❌'
      status: 'success'
    `);
    expect(summarizeOfflineEntitySyncState(env.apiStore.getOfflineEntities()))
      .toMatchInlineSnapshot(`
        - entityKey: '"users||1'
          requiresResolution: '✅'
          syncState: 'resolution-required'
      `);

    hook.unmount();
  });
});

type DeleteListQueryUserOperations = {
  deleteUser: ListQueryOfflineOperationDefinition<
    { id: number; name: string },
    ListQueryParams,
    string,
    { itemId: string }
  >;
};

describe('list-query overlays', () => {
  test('list-query invalidation keeps a pending patched row visible until replay settles', async () => {
    network.setOffline();
    const usersQuery = { tableId: 'users' } as const;
    const env = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      PatchUserOperations
    >(
      { users: [{ id: 1, name: 'Ada' }] },
      {
        id: 'offline-overlay-patch-store',
        getSessionKey: () => 'offline-overlay-patch-session',
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => 'offline-overlay-patch-session',
              config: { network: network.config },
            }),
            operations: {
              patchUserName: {
                inputSchema: userPatchSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: ({ input }) =>
                  new Promise((resolve) => {
                    setTimeout(() => {
                      resolve({ name: input.name });
                    }, 2000);
                  }),
              },
            },
          },
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

    // Start from an optimistic pending row that is still waiting for replay.
    await act(async () => {
      await env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('users||1', (item) => ({
            ...item,
            name: 'Ada pending',
          }));
        },
        mutation: () => Promise.resolve({ name: 'Ada replayed' }),
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Ada replayed' },
        },
      });
    });

    expect(hook.result.current).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      isLoading: '❌'
      isLoadingMore: '❌'
      items: ['Ada pending']
      payload: { tableId: 'users' }
      pendingSync: '✅'
      queryKey: '{tableId:"users"}'
      status: 'success'
    `);

    // A refetch that finishes before replay should not blank or revert the row.
    reconnectAndInvalidate(() => {
      env.scheduleFetch('highPriority', usersQuery);
    });
    await waitForStaleInvalidationToFinish();

    expect(hook.result.current).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      isLoading: '❌'
      isLoadingMore: '❌'
      items: ['Ada pending']
      payload: { tableId: 'users' }
      pendingSync: '✅'
      queryKey: '{tableId:"users"}'
      status: 'success'
    `);

    // Once replay succeeds, the derived overlay should disappear.
    await waitForReplayToSettle();

    expect(hook.result.current).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      isLoading: '❌'
      isLoadingMore: '❌'
      items: ['Ada']
      payload: { tableId: 'users' }
      pendingSync: '❌'
      queryKey: '{tableId:"users"}'
      status: 'success'
    `);

    hook.unmount();
  });

  test('list-query item invalidation keeps pending optimistic data visible until replay settles', async () => {
    const usersQuery = { tableId: 'users' } as const;
    const env = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      PatchUserOperations
    >(
      { users: [{ id: 1, name: 'Ada' }] },
      {
        id: 'offline-list-item-overlay-store',
        getSessionKey: () => 'offline-list-item-overlay-session',
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => 'offline-list-item-overlay-session',
              config: { network: network.config },
            }),
            operations: {
              patchUserName: {
                inputSchema: userPatchSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: ({ input }) =>
                  new Promise((resolve) => {
                    setTimeout(() => {
                      env.apiStore.updateItemState(input.itemId, (item) => ({
                        ...item,
                        name: input.name,
                      }));
                      resolve({ name: input.name });
                    }, 2000);
                  }),
              },
            },
          },
        },
      },
    );

    const hook = renderHook(() =>
      env.apiStore.useItem('users||1', {
        selector: (item) => item?.name ?? null,
      }),
    );
    await flushAllTimers();

    // Exercise the standalone item-fetch path first so the hook is not relying
    // solely on query-derived cache state when we replay the offline mutation.
    act(() => {
      env.scheduleItemFetch('highPriority', 'users||1');
    });
    await flushAllTimers();
    network.setOffline();

    // Queue an optimistic edit after the standalone item cache is already populated.
    await act(async () => {
      await env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('users||1', (item) => ({
            ...item,
            name: 'Ada pending',
          }));
        },
        mutation: () => Promise.resolve({ name: 'Ada replayed' }),
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Ada replayed' },
        },
      });
    });

    expect(hook.result.current).toMatchInlineSnapshot(`
      data: 'Ada pending'
      error: null
      isLoading: '❌'
      itemStateKey: '"users||1'
      payload: 'users||1'
      pendingSync: '✅'
      status: 'success'
    `);

    // A direct item refetch should preserve the optimistic overlay until replay finishes.
    reconnectAndInvalidate(() => {
      env.scheduleItemFetch('highPriority', 'users||1');
    });
    await waitForStaleInvalidationToFinish();

    expect(hook.result.current).toMatchInlineSnapshot(`
      data: 'Ada pending'
      error: null
      isLoading: '❌'
      itemStateKey: '"users||1'
      payload: 'users||1'
      pendingSync: '✅'
      status: 'success'
    `);

    // Once replay settles, the standalone item view should show the replayed value.
    await waitForReplayToSettle();

    expect(hook.result.current).toMatchInlineSnapshot(`
      data: 'Ada replayed'
      error: null
      isLoading: '❌'
      itemStateKey: '"users||1'
      payload: 'users||1'
      pendingSync: '❌'
      status: 'success'
    `);

    hook.unmount();
  });

  test('list-query invalidation keeps a pending temp row at its last known position', async () => {
    network.setOffline();
    let nextUserId = 3;
    const usersQuery = { tableId: 'users' } as const;
    const env = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      CreateListQueryUserOperations
    >(
      {
        users: [
          { id: 1, name: 'Ada' },
          { id: 2, name: 'Grace' },
        ],
      },
      {
        id: 'offline-overlay-create-store',
        getSessionKey: () => 'offline-overlay-create-session',
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => 'offline-overlay-create-session',
              config: { network: network.config },
            }),
            operations: {
              createUser: {
                inputSchema: collectionCreateInputSchema,
                getEntityRefs: ({ input }) => [`temp:${input.name}`],
                tempEntity: {
                  buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                  reconcileServerEntity: (result) => ({
                    finalPayload: `users||${result.id}`,
                    finalData: result,
                  }),
                },
                execute: ({ input }) =>
                  new Promise((resolve) => {
                    setTimeout(() => {
                      resolve({ id: nextUserId, name: input.name });
                      nextUserId += 1;
                    }, 2000);
                  }),
              },
            },
          },
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

    // Add a temp row optimistically to the end of the list while offline.
    await act(async () => {
      await env.apiStore.performMutation(null, {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            'temp:Linus offline',
            { id: -1, name: 'Linus offline' },
            { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
          );
        },
        mutation: () => Promise.resolve({ id: 3, name: 'Linus offline' }),
        offline: { operation: 'createUser', input: { name: 'Linus offline' } },
      });
    });

    expect(hook.result.current).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      isLoading: '❌'
      isLoadingMore: '❌'
      items: ['Ada', 'Grace', 'Linus offline']
      payload: { tableId: 'users' }
      pendingSync: '✅'
      queryKey: '{tableId:"users"}'
      status: 'success'
    `);

    // A stale refetch should keep the temp row visible in the same slot.
    reconnectAndInvalidate(() => {
      env.scheduleFetch('highPriority', usersQuery);
    });
    await waitForStaleInvalidationToFinish();

    expect(hook.result.current).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      isLoading: '❌'
      isLoadingMore: '❌'
      items: ['Ada', 'Grace', 'Linus offline']
      payload: { tableId: 'users' }
      pendingSync: '✅'
      queryKey: '{tableId:"users"}'
      status: 'success'
    `);

    // After replay succeeds, the derived overlay disappears and the list falls
    // back to the last server-derived membership until another list refresh runs.
    await waitForReplayToSettle();

    expect(hook.result.current).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      isLoading: '❌'
      isLoadingMore: '❌'
      items: ['Ada', 'Grace']
      payload: { tableId: 'users' }
      pendingSync: '❌'
      queryKey: '{tableId:"users"}'
      status: 'success'
    `);
    expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`
      id: 3
      name: 'Linus offline'
    `);

    hook.unmount();
  });

  test('list-query overlay stops deriving temp rows once replay needs manual resolution', async () => {
    network.setOffline();
    const usersQuery = { tableId: 'users' } as const;
    const env = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      CreateListQueryUserOperations
    >(
      {
        users: [
          { id: 1, name: 'Ada' },
          { id: 2, name: 'Grace' },
        ],
      },
      {
        id: 'offline-overlay-resolution-store',
        getSessionKey: () => 'offline-overlay-resolution-session',
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => 'offline-overlay-resolution-session',
              config: {
                network: network.config,
                replayRetry: { maxFailures: 1, intervalMs: 1 },
              },
            }),
            operations: {
              createUser: {
                inputSchema: collectionCreateInputSchema,
                getEntityRefs: ({ input }) => [`temp:${input.name}`],
                tempEntity: {
                  buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                  reconcileServerEntity: () => {
                    throw new Error(
                      'Should not reconcile after replay failure',
                    );
                  },
                },
                execute: () => {
                  throw new Error('Replay failed');
                },
              },
            },
          },
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

    // Keep the temp row visible while it is still actively pending.
    await act(async () => {
      await env.apiStore.performMutation(null, {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            'temp:Linus blocked',
            { id: -1, name: 'Linus blocked' },
            { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
          );
        },
        mutation: () => Promise.resolve({ id: 3, name: 'Linus blocked' }),
        offline: { operation: 'createUser', input: { name: 'Linus blocked' } },
      });
    });

    // Reconnect and let replay convert the temp row into a manual-resolution entry.
    reconnectAndInvalidate(() => {
      env.scheduleFetch('highPriority', usersQuery);
    });
    await flushAllTimers();

    // Once the queue entry becomes a resolution, the derived row should disappear.
    expect(hook.result.current).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      isLoading: '❌'
      isLoadingMore: '❌'
      items: ['Ada', 'Grace']
      payload: { tableId: 'users' }
      pendingSync: '❌'
      queryKey: '{tableId:"users"}'
      status: 'success'
    `);
    expect(summarizeOfflineEntitySyncState(env.apiStore.getOfflineEntities()))
      .toMatchInlineSnapshot(`
        - entityKey: '"temp:Linus blocked'
          requiresResolution: '✅'
          syncState: 'resolution-required'
      `);

    hook.unmount();
  });

  test('list-query invalidation keeps pending deletes hidden until replay settles', async () => {
    network.setOffline();
    const usersQuery = { tableId: 'users' } as const;
    const env = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      DeleteListQueryUserOperations
    >(
      { users: [{ id: 1, name: 'Ada' }] },
      {
        id: 'offline-list-delete-overlay-store',
        getSessionKey: () => 'offline-list-delete-overlay-session',
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => 'offline-list-delete-overlay-session',
              config: { network: network.config },
            }),
            operations: {
              deleteUser: {
                inputSchema: deleteItemInputSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: ({ input }) =>
                  new Promise((resolve) => {
                    setTimeout(() => {
                      env.apiStore.deleteItemState(input.itemId);
                      resolve(undefined);
                    }, 2000);
                  }),
              },
            },
          },
        },
      },
    );

    const hook = renderHook(() =>
      env.apiStore.useListQuery(usersQuery, {
        itemSelector: (item) => item.name,
      }),
    );
    await flushAllTimers();

    // Queue a delete that removes the row from the rendered list immediately.
    await act(async () => {
      await env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.deleteItemState('users||1');
        },
        mutation: () => Promise.resolve(undefined),
        offline: { operation: 'deleteUser', input: { itemId: 'users||1' } },
      });
    });

    expect(hook.result.current).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      isLoading: '❌'
      isLoadingMore: '❌'
      items: []
      payload: { tableId: 'users' }
      pendingSync: '❌'
      queryKey: '{tableId:"users"}'
      status: 'success'
    `);
    expect(summarizeOfflineEntitySyncState(env.apiStore.getOfflineEntities()))
      .toMatchInlineSnapshot(`
        - entityKey: '"users||1'
          pendingMutations: 1
          requiresResolution: '❌'
          syncState: 'pending'
      `);

    // A stale refetch should keep the list empty while the delete is still pending.
    reconnectAndInvalidate(() => {
      env.scheduleFetch('highPriority', usersQuery);
    });
    await waitForStaleInvalidationToFinish();

    expect(hook.result.current).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      isLoading: '❌'
      isLoadingMore: '❌'
      items: []
      payload: { tableId: 'users' }
      pendingSync: '❌'
      queryKey: '{tableId:"users"}'
      status: 'success'
    `);
    expect(summarizeOfflineEntitySyncState(env.apiStore.getOfflineEntities()))
      .toMatchInlineSnapshot(`
        - entityKey: '"users||1'
          pendingMutations: 1
          requiresResolution: '❌'
          syncState: 'syncing'
      `);

    // Replay completion should clear the pending delete metadata without changing the empty list.
    await waitForReplayToSettle();

    expect(hook.result.current).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      isLoading: '❌'
      isLoadingMore: '❌'
      items: []
      payload: { tableId: 'users' }
      pendingSync: '❌'
      queryKey: '{tableId:"users"}'
      status: 'success'
    `);
    expect(
      summarizeOfflineEntitySyncState(env.apiStore.getOfflineEntities()),
    ).toMatchInlineSnapshot(`[]`);

    hook.unmount();
  });
});
