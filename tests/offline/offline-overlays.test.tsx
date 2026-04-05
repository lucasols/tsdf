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

    // Start from a real loaded document so reconnecting can briefly fetch the
    // stale server snapshot while the offline replay is still pending.
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
                    env.serverMock.setData(input.value);
                    resolve(input);
                  }, 2000);
                }),
            },
          },
        },
      },
    });

    // Track the document surface that application code would render.
    const hook = renderHook(() => {
      const doc = env.apiStore.useDocument();
      env.trackUIChanges(
        `value:${doc.data?.value ?? 'null'} pending:${doc.pendingSync ? 'yes' : 'no'}`,
      );
      return doc;
    });
    await Promise.resolve();

    // Queue an optimistic document edit while the browser is offline.
    env.addTimelineComments('beforeNextAction', [
      'queue an optimistic edit while offline',
    ]);
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

    // Let a stale refetch land before the queued replay finishes.
    env.addTimelineComments('beforeNextAction', [
      'reconnect — stale refetch lands before replay finishes',
    ]);
    reconnectAndInvalidate(() => {
      env.scheduleFetch('highPriority');
    });
    await waitForStaleInvalidationToFinish();

    // store state should reflect the last successful server snapshot, not the optimistic overlay.
    expect({
      data: env.store.state.data,
      error: env.store.state.error,
      status: env.store.state.status,
    }).toMatchInlineSnapshot(`
      data: { value: 1 }
      error: null
      status: 'success'
    `);

    const awaitedResultPromise = env.apiStore.awaitFetch();
    await waitForStaleInvalidationToFinish();
    const awaitedResult = await awaitedResultPromise;

    expect({
      awaitedResult,
      state: {
        data: env.store.state.data,
        error: env.store.state.error,
        status: env.store.state.status,
      },
    }).toMatchInlineSnapshot(`
      awaitedResult:
        data: { value: 1 }
        error: null

      state:
        data: { value: 1 }
        error: null
        status: 'success'
    `);

    // Once replay settles, the optimistic overlay should no longer be needed.
    env.addTimelineComments('beforeNextAction', [
      'replay settles — optimistic overlay no longer needed',
    ]);
    await waitForReplayToSettle();

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | ui                    |
      0     | "value:1 pending:no"  | ui-initialized
      .     | "value:1 pending:no"  | -- queue an optimistic edit while offline
      .     | "value:2 pending:no"  | ui-changed
      .     | "value:2 pending:yes" | ui-changed
      .     | "value:2 pending:yes" | offline:updateValue queued
      .     | "value:2 pending:yes" | -- reconnect — stale refetch lands before replay finishes
      .     | "value:2 pending:yes" | scheduled-fetch-coalesced
      .     | "value:2 pending:yes" | offline:updateValue replay-started
      10ms  | "value:2 pending:yes" | 🔴 >fetch-started
      810ms | "value:2 pending:yes" | 🔴 <fetch-finished (value: 1)
      820ms | "value:2 pending:yes" | 🟠 >fetch-started
      1.62s | "value:2 pending:yes" | 🟠 <fetch-finished (value: 1)
      2s    | "value:2 pending:yes" | -- replay settles — optimistic overlay no longer needed
      .     | "value:2 pending:yes" | server-data-changed (value: 2)
      .     | "value:2 pending:yes" | offline:updateValue replay-finished
      .     | "value:1 pending:no"  | ui-changed
      "
    `);

    hook.unmount();
  });

  test('document offline overlay stops deriving once replay requires manual resolution', async () => {
    network.setOffline();

    // Start from loaded server data so a reconnect can restore that snapshot
    // once replay gives up and turns the queued mutation into a resolution.
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

    // Track the user-facing document view.
    const hook = renderHook(() => {
      const doc = env.apiStore.useDocument();
      env.trackUIChanges(
        `value:${doc.data?.value ?? 'null'} pending:${doc.pendingSync ? 'yes' : 'no'}`,
      );
      return doc;
    });
    await Promise.resolve();

    // Queue an optimistic document edit that will later fail during replay.
    env.addTimelineComments('beforeNextAction', [
      'queue an optimistic edit that will fail during replay',
    ]);
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
    env.addTimelineComments('beforeNextAction', [
      'reconnect — replay fails and requires manual resolution',
    ]);
    reconnectAndInvalidate(() => {
      env.scheduleFetch('highPriority');
    });
    await flushAllTimers();

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | ui                    |
      0     | "value:1 pending:no"  | ui-initialized
      .     | "value:1 pending:no"  | -- queue an optimistic edit that will fail during replay
      .     | "value:2 pending:no"  | ui-changed
      .     | "value:2 pending:yes" | ui-changed
      .     | "value:2 pending:yes" | offline:updateValue queued
      .     | "value:2 pending:yes" | -- reconnect — replay fails and requires manual resolution
      .     | "value:2 pending:yes" | scheduled-fetch-coalesced
      .     | "value:2 pending:yes" | offline:updateValue replay-started
      .     | "value:2 pending:yes" | offline:updateValue resolution-required
      .     | "value:2 pending:no"  | ui-changed
      10ms  | "value:2 pending:no"  | 🔴 >fetch-started
      810ms | "value:2 pending:no"  | 🔴 <fetch-finished (value: 1)
      .     | "value:1 pending:no"  | ui-changed
      "
    `);

    // The queued entity should remain visible only in the offline-resolution summary.
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

    // Seed a real loaded item so reconnecting can refetch stale server data
    // while the queued offline rename is still waiting to replay.
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
                      env.serverTable.updateItem('users||1', {
                        name: input.name,
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

    // Track the rendered item name and pending state.
    const hook = renderHook(() => {
      const item = env.apiStore.useItem('users||1', {
        selector: (i) => i?.value.name ?? null,
      });
      env.trackItemUI('name', item.data ?? 'null');
      env.trackItemUI('pending', item.pendingSync ? 'yes' : 'no');
      return item;
    });
    await Promise.resolve();

    // Queue an optimistic rename while the item is offline-visible.
    env.addTimelineComments('beforeNextAction', [
      'queue an optimistic rename while offline',
    ]);
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

    // A refetch finishing first should not replace the optimistic item overlay.
    env.addTimelineComments('beforeNextAction', [
      'reconnect — stale refetch must not revert the optimistic name',
    ]);
    reconnectAndInvalidate(() => {
      env.scheduleFetch('highPriority', 'users||1');
    });
    await waitForStaleInvalidationToFinish();

    // Once replay finishes, the overlay can collapse into the real item state.
    env.addTimelineComments('beforeNextAction', [
      'replay settles — overlay collapses into real item state',
    ]);
    await waitForReplayToSettle();

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | name        | pending |
      0     | Ada         | no      | [name, pending] ui-initialized
      .     | Ada         | no      | -- queue an optimistic rename while offline
      .     | Ada pending | yes     | [name, pending] ui-changed
      .     | Ada pending | yes     | offline:renameItem queued
      .     | Ada pending | yes     | -- reconnect — stale refetch must not revert the optimistic name
      .     | Ada pending | yes     | [users||1] scheduled-fetch-coalesced
      .     | Ada pending | yes     | offline:renameItem replay-started
      10ms  | Ada pending | yes     | 🔴 [users||1] >fetch-started
      810ms | Ada pending | yes     | 🔴 [users||1] <fetch-finished (value: {"name":"Ada"})
      2s    | Ada pending | yes     | -- replay settles — overlay collapses into real item state
      .     | Ada pending | yes     | [users||1] server-data-changed (value: {"name":"Ada replayed"})
      .     | Ada pending | yes     | offline:renameItem replay-finished
      .     | Ada         | no      | [name, pending] ui-changed
      "
    `);

    hook.unmount();
  });

  test('collection invalidation keeps pending deletes hidden until replay settles', async () => {
    network.setOffline();

    // Start from a loaded collection item so reconnecting can refetch the stale
    // server row while the offline delete is still queued.
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
                      env.serverTable.removeItem(input.itemId);
                      resolve(undefined);
                    }, 2000);
                  }),
              },
            },
          },
        },
      },
    );

    // Track the item selector a component would render after a delete.
    const hook = renderHook(() => {
      const item = env.apiStore.useItem('users||1', {
        selector: (i) => i?.value.name ?? null,
      });
      env.trackItemUI('name', item.data ?? 'null');
      env.trackItemUI('status', item.status);
      env.trackItemUI('pending', item.pendingSync ? 'yes' : 'no');
      return item;
    });
    await Promise.resolve();

    // Queue a delete so the item disappears immediately from the UI.
    env.addTimelineComments('beforeNextAction', [
      'queue a delete — item disappears immediately',
    ]);
    await act(async () => {
      await env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.deleteItemState('users||1');
        },
        mutation: () => Promise.resolve(undefined),
        offline: { operation: 'deleteItem', input: { itemId: 'users||1' } },
      });
    });

    // A stale refetch should keep the item hidden while the delete is still pending.
    env.addTimelineComments('beforeNextAction', [
      'reconnect — stale refetch must not resurrect the deleted item',
    ]);
    reconnectAndInvalidate(() => {
      env.scheduleFetch('highPriority', 'users||1');
    });
    await waitForStaleInvalidationToFinish();

    // Replay completion should only clear the sync metadata, not change the deleted UI.
    env.addTimelineComments('beforeNextAction', [
      'replay settles — delete metadata clears, UI stays deleted',
    ]);
    await waitForReplayToSettle();

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | name | pending | status  |
      0     | Ada  | no      | success | [name, status, pending] ui-initialized
      .     | Ada  | no      | success | -- queue a delete — item disappears immediately
      .     | null | yes     | deleted | [name, status, pending] ui-changed
      .     | null | yes     | deleted | offline:deleteItem queued
      .     | null | yes     | deleted | -- reconnect — stale refetch must not resurrect the deleted item
      .     | null | yes     | deleted | [users||1] scheduled-fetch-triggered
      .     | null | yes     | deleted | offline:deleteItem replay-started
      10ms  | null | yes     | deleted | 🔴 [users||1] >fetch-started
      810ms | null | yes     | deleted | 🔴 [users||1] <fetch-finished (value: {"name":"Ada"})
      2s    | null | yes     | deleted | -- replay settles — delete metadata clears, UI stays deleted
      .     | null | yes     | deleted | [users||1] server-item-removed
      .     | null | yes     | deleted | offline:deleteItem replay-finished
      .     | Ada  | no      | success | [name, status, pending] ui-changed
      "
    `);

    hook.unmount();
  });

  test('collection offline overlay stops deriving once replay requires manual resolution', async () => {
    network.setOffline();

    // Use loaded collection data so replay failure can restore the last
    // server-backed item once the optimistic overlay stops deriving.
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

    // Track the rendered item name.
    const hook = renderHook(() => {
      const item = env.apiStore.useItem('users||1', {
        selector: (i) => i?.value.name ?? null,
      });
      env.trackItemUI('name', item.data ?? 'null');
      env.trackItemUI('pending', item.pendingSync ? 'yes' : 'no');
      return item;
    });
    await Promise.resolve();

    // Queue an optimistic rename that replay will reject into manual resolution.
    env.addTimelineComments('beforeNextAction', [
      'queue an optimistic rename that will fail during replay',
    ]);
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
    env.addTimelineComments('beforeNextAction', [
      'reconnect — replay fails and restores last server-backed value',
    ]);
    reconnectAndInvalidate(() => {
      env.scheduleFetch('highPriority', 'users||1');
    });
    await flushAllTimers();

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | name        | pending |
      0     | Ada         | no      | [name, pending] ui-initialized
      .     | Ada         | no      | -- queue an optimistic rename that will fail during replay
      .     | Ada pending | yes     | [name, pending] ui-changed
      .     | Ada pending | yes     | offline:renameItem queued
      .     | Ada pending | yes     | -- reconnect — replay fails and restores last server-backed value
      .     | Ada pending | yes     | [users||1] scheduled-fetch-coalesced
      .     | Ada pending | yes     | offline:renameItem replay-started
      .     | Ada pending | yes     | offline:renameItem resolution-required
      .     | Ada pending | no      | [pending] ui-changed
      10ms  | Ada pending | no      | 🔴 [users||1] >fetch-started
      810ms | Ada pending | no      | 🔴 [users||1] <fetch-finished (value: {"name":"Ada"})
      .     | Ada         | no      | [name] ui-changed
      "
    `);

    // The unresolved work should now live only in the offline entity summary.
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

    // Start from a loaded query so reconnecting can refetch the stale server
    // list while the queued optimistic row patch is still pending replay.
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
                      env.serverTable.updateItem(input.itemId, {
                        name: input.name,
                      });
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
      env.trackItemUI('pending', query.pendingSync ? 'yes' : 'no');
      return query;
    });
    await flushAllTimers();

    // Queue an optimistic row edit while offline.
    env.addTimelineComments('beforeNextAction', [
      'queue an optimistic row patch while offline',
    ]);
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

    // A refetch that finishes before replay should not blank or revert the row.
    env.addTimelineComments('beforeNextAction', [
      'reconnect — stale refetch must not revert the optimistic row',
    ]);
    reconnectAndInvalidate(() => {
      env.scheduleFetch('highPriority', usersQuery);
    });
    await waitForStaleInvalidationToFinish();

    // Once replay succeeds, the derived overlay should disappear.
    env.addTimelineComments('beforeNextAction', [
      'replay settles — overlay disappears',
    ]);
    await waitForReplayToSettle();

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | pending | query-items | query-status |
      0     | no      | Ada         | success      | [query-status, query-items, pending] ui-initialized
      3.01s | no      | Ada         | success      | -- queue an optimistic row patch while offline
      .     | yes     | Ada pending | success      | [query-items, pending] ui-changed
      .     | yes     | Ada pending | success      | offline:patchUserName queued
      .     | yes     | Ada pending | success      | -- reconnect — stale refetch must not revert the optimistic row
      .     | yes     | Ada pending | success      | scheduled-fetch-triggered
      .     | yes     | Ada pending | success      | offline:patchUserName replay-started
      3.02s | yes     | Ada pending | success      | 🔴 >list-fetch-started
      3.82s | yes     | Ada pending | success      | 🔴 <list-fetch-finished (value: {"count":1})
      5.01s | yes     | Ada pending | success      | -- replay settles — overlay disappears
      .     | yes     | Ada pending | success      | [users||1] server-data-changed (value: {"name":"Ada replayed"})
      .     | yes     | Ada pending | success      | offline:patchUserName replay-finished
      .     | no      | Ada         | success      | [query-items, pending] ui-changed
      "
    `);

    hook.unmount();
  });

  test('list-query item invalidation keeps pending optimistic data visible until replay settles', async () => {
    const usersQuery = { tableId: 'users' } as const;

    // Load both query and standalone item state so this test proves the item
    // overlay path works even when it is not relying on query-derived data.
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
                      env.serverTable.updateItem(input.itemId, {
                        name: input.name,
                      });
                      resolve({ name: input.name });
                    }, 2000);
                  }),
              },
            },
          },
        },
      },
    );

    // Track the standalone item view.
    const hook = renderHook(() => {
      const item = env.apiStore.useItem('users||1', {
        selector: (i) => i?.name ?? null,
      });
      env.trackItemUI('item-name', item.data ?? 'null');
      env.trackItemUI('pending', item.pendingSync ? 'yes' : 'no');
      return item;
    });
    await flushAllTimers();

    // Exercise the standalone item-fetch path first so the hook is not relying
    // solely on query-derived cache state when we replay the offline mutation.
    act(() => {
      env.scheduleItemFetch('highPriority', 'users||1');
    });
    await flushAllTimers();
    network.setOffline();

    // Queue an optimistic edit after the standalone item cache is already populated.
    env.addTimelineComments('beforeNextAction', [
      'queue an optimistic item edit while offline',
    ]);
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

    // A direct item refetch should preserve the optimistic overlay until replay finishes.
    env.addTimelineComments('beforeNextAction', [
      'reconnect — direct item refetch must not restore stale value',
    ]);
    reconnectAndInvalidate(() => {
      env.scheduleItemFetch('highPriority', 'users||1');
    });
    await waitForStaleInvalidationToFinish();

    // Once replay settles, the standalone item view should show the replayed value.
    env.addTimelineComments('beforeNextAction', [
      'replay settles — item shows replayed value',
    ]);
    await waitForReplayToSettle();

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item-name   | pending |
      0     | Ada         | no      | [item-name, pending] ui-initialized
      10ms  | Ada         | no      | 🔴 [users||1] >fetch-started
      810ms | Ada         | no      | 🔴 [users||1] <fetch-finished (value: {"id":1,"name":"Ada"})
      2s    | Ada         | no      | [users||1] scheduled-fetch-triggered
      2.01s | Ada         | no      | 🟠 [users||1] >fetch-started
      2.81s | Ada         | no      | 🟠 [users||1] <fetch-finished (value: {"id":1,"name":"Ada"})
      3.81s | Ada         | no      | -- queue an optimistic item edit while offline
      .     | Ada pending | yes     | [item-name, pending] ui-changed
      .     | Ada pending | yes     | offline:patchUserName queued
      .     | Ada pending | yes     | -- reconnect — direct item refetch must not restore stale value
      .     | Ada pending | yes     | [users||1] scheduled-fetch-triggered
      .     | Ada pending | yes     | offline:patchUserName replay-started
      3.82s | Ada pending | yes     | 🟡 [users||1] >fetch-started
      4.62s | Ada pending | yes     | 🟡 [users||1] <fetch-finished (value: {"id":1,"name":"Ada"})
      5.81s | Ada pending | yes     | -- replay settles — item shows replayed value
      .     | Ada pending | yes     | [users||1] server-data-changed (value: {"name":"Ada replayed"})
      .     | Ada pending | yes     | offline:patchUserName replay-finished
      .     | Ada         | no      | [item-name, pending] ui-changed
      "
    `);

    hook.unmount();
  });

  test('list-query invalidation keeps a pending temp row at its last known position', async () => {
    network.setOffline();
    let nextUserId = 3;
    const usersQuery = { tableId: 'users' } as const;

    // Start from a loaded ordered list so the test can verify the temporary row
    // stays anchored to its optimistic position across a stale refetch.
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
                      const id = nextUserId;
                      nextUserId += 1;
                      const itemId = `users||${id}`;
                      const data = { id, name: input.name };
                      env.serverTable.setItem(itemId, data);
                      resolve(data);
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
      env.trackItemUI('pending', query.pendingSync ? 'yes' : 'no');
      return query;
    });
    await flushAllTimers();

    // Add a temp row optimistically to the end of the list while offline.
    env.addTimelineComments('beforeNextAction', [
      'add a temp row optimistically to the end of the list',
    ]);
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

    // A stale refetch should keep the temp row visible in the same slot.
    env.addTimelineComments('beforeNextAction', [
      'reconnect — stale refetch must keep the temp row in place',
    ]);
    reconnectAndInvalidate(() => {
      env.scheduleFetch('highPriority', usersQuery);
    });
    await waitForStaleInvalidationToFinish();

    // After replay succeeds, the derived overlay disappears and the list falls
    // back to the last server-derived membership until another list refresh runs.
    env.addTimelineComments('beforeNextAction', [
      'replay settles — temp overlay removed, list falls back to server membership',
    ]);
    await waitForReplayToSettle();

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | pending | query-items               | query-status |
      0     | no      | Ada, Grace                | success      | [query-status, query-items, pending] ui-initialized
      3.01s | no      | Ada, Grace                | success      | -- add a temp row optimistically to the end of the list
      .     | yes     | Ada, Grace, Linus offline | success      | [query-items, pending] ui-changed
      .     | yes     | Ada, Grace, Linus offline | success      | offline:createUser queued
      .     | yes     | Ada, Grace, Linus offline | success      | -- reconnect — stale refetch must keep the temp row in place
      .     | yes     | Ada, Grace, Linus offline | success      | scheduled-fetch-triggered
      .     | yes     | Ada, Grace, Linus offline | success      | offline:createUser replay-started
      3.02s | yes     | Ada, Grace, Linus offline | success      | 🔴 >list-fetch-started
      3.82s | yes     | Ada, Grace, Linus offline | success      | 🔴 <list-fetch-finished (value: {"count":2})
      5.01s | yes     | Ada, Grace, Linus offline | success      | -- replay settles — temp overlay removed, list falls back to server membership
      .     | yes     | Ada, Grace, Linus offline | success      | [users||3] server-data-changed (value: {"id":3,"name":"Linus offline"})
      .     | yes     | Ada, Grace, Linus offline | success      | offline:createUser replay-finished
      .     | no      | Ada, Grace                | success      | [query-items, pending] ui-changed
      "
    `);

    // The reconciled item should still exist in the store after replay.
    expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`
      id: 3
      name: 'Linus offline'
    `);

    hook.unmount();
  });

  test('list-query overlay stops deriving temp rows once replay needs manual resolution', async () => {
    network.setOffline();
    const usersQuery = { tableId: 'users' } as const;
    // Start from a loaded list so replay failure can fall back to the last
    // server-backed query membership once the temp overlay stops deriving.
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
      env.trackItemUI('pending', query.pendingSync ? 'yes' : 'no');
      return query;
    });
    await flushAllTimers();

    // Keep the temp row visible while it is still actively pending.
    env.addTimelineComments('beforeNextAction', [
      'add a temp row that will fail during replay',
    ]);
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
    env.addTimelineComments('beforeNextAction', [
      'reconnect — replay fails, temp row disappears from the rendered list',
    ]);
    reconnectAndInvalidate(() => {
      env.scheduleFetch('highPriority', usersQuery);
    });
    await flushAllTimers();

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | pending | query-items               | query-status |
      0     | no      | Ada, Grace                | success      | [query-status, query-items, pending] ui-initialized
      3.01s | no      | Ada, Grace                | success      | -- add a temp row that will fail during replay
      .     | yes     | Ada, Grace, Linus blocked | success      | [query-items, pending] ui-changed
      .     | yes     | Ada, Grace, Linus blocked | success      | offline:createUser queued
      .     | yes     | Ada, Grace, Linus blocked | success      | -- reconnect — replay fails, temp row disappears from the rendered list
      .     | yes     | Ada, Grace, Linus blocked | success      | scheduled-fetch-triggered
      .     | yes     | Ada, Grace, Linus blocked | success      | offline:createUser replay-started
      .     | yes     | Ada, Grace, Linus blocked | success      | offline:createUser resolution-required
      .     | no      | Ada, Grace, Linus blocked | success      | [pending] ui-changed
      3.02s | no      | Ada, Grace, Linus blocked | success      | 🔴 >list-fetch-started
      3.82s | no      | Ada, Grace, Linus blocked | success      | 🔴 <list-fetch-finished (value: {"count":2})
      .     | no      | Ada, Grace                | success      | [query-items] ui-changed
      "
    `);

    // The unresolved temp entity should survive only in offline resolution state.
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
    // Start from a loaded list so reconnecting can refetch the stale server row
    // while the offline delete is still represented only as an overlay.
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
                      env.serverTable.removeItem(input.itemId);
                      resolve(undefined);
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

    // Queue a delete that removes the row from the rendered list immediately.
    env.addTimelineComments('beforeNextAction', [
      'queue a delete — row disappears immediately from the list',
    ]);
    await act(async () => {
      await env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.deleteItemState('users||1');
        },
        mutation: () => Promise.resolve(undefined),
        offline: { operation: 'deleteUser', input: { itemId: 'users||1' } },
      });
    });

    // The pending delete still has to exist in offline state even though the
    // rendered list already looks deleted.
    expect(summarizeOfflineEntitySyncState(env.apiStore.getOfflineEntities()))
      .toMatchInlineSnapshot(`
        - entityKey: '"users||1'
          pendingMutations: 1
          requiresResolution: '❌'
          syncState: 'pending'
      `);

    // A stale refetch should keep the list empty while the delete is still pending.
    env.addTimelineComments('beforeNextAction', [
      'reconnect — stale refetch must not bring the deleted row back',
    ]);
    reconnectAndInvalidate(() => {
      env.scheduleFetch('highPriority', usersQuery);
    });
    await waitForStaleInvalidationToFinish();

    // Reconnecting moves the delete from pending to syncing, but it is still
    // not fully settled until replay finishes.
    expect(summarizeOfflineEntitySyncState(env.apiStore.getOfflineEntities()))
      .toMatchInlineSnapshot(`
        - entityKey: '"users||1'
          pendingMutations: 1
          requiresResolution: '❌'
          syncState: 'syncing'
      `);

    // Replay completion should clear the pending delete metadata without changing the empty list.
    env.addTimelineComments('beforeNextAction', [
      'replay settles — delete metadata clears, list stays empty',
    ]);
    await waitForReplayToSettle();

    expect(
      summarizeOfflineEntitySyncState(env.apiStore.getOfflineEntities()),
    ).toMatchInlineSnapshot(`[]`);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | query-items | query-status |
      0     | Ada         | success      | [query-status, query-items] ui-initialized
      3.01s | Ada         | success      | -- queue a delete — row disappears immediately from the list
      .     |             | success      | [query-items] ui-changed
      .     |             | success      | offline:deleteUser queued
      .     |             | success      | -- reconnect — stale refetch must not bring the deleted row back
      .     |             | success      | scheduled-fetch-triggered
      .     |             | success      | offline:deleteUser replay-started
      3.02s |             | success      | 🔴 >list-fetch-started
      3.82s |             | success      | 🔴 <list-fetch-finished (value: {"count":1})
      5.01s |             | success      | -- replay settles — delete metadata clears, list stays empty
      .     |             | success      | [users||1] server-item-removed
      .     |             | success      | offline:deleteUser replay-finished
      .     | Ada         | success      | [query-items] ui-changed
      "
    `);

    hook.unmount();
  });
});
