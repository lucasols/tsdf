import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { render, renderHook } from '@testing-library/react';
import { act, memo } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CollectionOfflineOperationDefinition } from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { flushAllTimers } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { withSuppressedActError } from '../utils/withSuppressedActError';
import {
  type CreateListQueryUserOperations,
  type CreateUserOperations,
  type PatchUserOperations,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  classifyRetryableReplayFailure,
  collectionCreateInputSchema,
  collectionSchema,
  listQueryQueryPayloadSchema,
} from './offlineTestShared';

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

type RenderLog = ReturnType<typeof createLoggerStore>;

/** Logs one line per component render (states are not split across lines). */
function createRenderLog(): RenderLog {
  return createLoggerStore({ maxLineLengthBeforeSplit: 200 });
}

describe('list-query rows', () => {
  type UserRow = { id: number; name: string };
  type UsersOperations = CreateListQueryUserOperations & PatchUserOperations;
  type UsersEnv = ReturnType<
    typeof createListQueryStoreTestEnv<UserRow, false, false, UsersOperations>
  >;

  const usersQuery = { tableId: 'users' } as const;

  /**
   * A users list that can create and rename users offline. Renames whose new
   * name is in `rejectedNames` are always refused by the server.
   */
  function createUsersEnv(
    sessionKey: string,
    rejectedNames: readonly string[] = [],
  ): UsersEnv {
    let nextUserId = 4;

    const env: UsersEnv = createListQueryStoreTestEnv<
      UserRow,
      false,
      false,
      UsersOperations
    >(
      {
        users: [
          { id: 1, name: 'Ada' },
          { id: 2, name: 'Grace' },
          { id: 3, name: 'Linus' },
        ],
      },
      {
        getSessionKey: () => sessionKey,
        storeManager: createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey: () => sessionKey,
          offlineSession: {
            network: network.config,
            classifyRetryableFailure: (error, ctx) =>
              classifyRetryableReplayFailure(error, ctx.phase),
          },
        }),
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            operations: {
              createUser: {
                inputSchema: collectionCreateInputSchema,
                kind: 'create',
                getEntityRefs: ({ input }) => [`temp:${input.name}`],
                tempEntity: {
                  buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                  reconcileServerEntity: (result) => ({
                    finalPayload: `users||${result.id}`,
                    finalData: result,
                  }),
                },
                execute: async ({ input }) => {
                  const result = { id: nextUserId, name: input.name };
                  nextUserId += 1;
                  await env.serverTable.delayedSetItem(
                    `users||${result.id}`,
                    result,
                  );
                  return result;
                },
              },
              patchUserName: {
                inputSchema: userPatchSchema,
                kind: 'update',
                getEntityRefs: ({ input }) => [input.itemId],
                execute: async ({ input }) => {
                  if (rejectedNames.includes(input.name)) {
                    throw new Error('rename rejected by the server');
                  }

                  await env.serverTable.delayedUpdateItem(input.itemId, {
                    name: input.name,
                  });
                  return { name: input.name };
                },
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

    return env;
  }

  /**
   * Renders the users list the way an app would: the list maps its items to
   * memoized rows, and each row reads only its own offline state for a badge.
   * Every row render is logged, so the log also shows which rows re-rendered.
   */
  function renderUsersList(env: UsersEnv, renders: RenderLog) {
    const Row = memo(function Row({ itemPayload }: { itemPayload: string }) {
      const offlineState = env.apiStore.useItemOfflineState(itemPayload);

      renders.add({ row: itemPayload, offlineState });

      return null;
    });

    function UsersList() {
      const query = env.apiStore.useListQuery(usersQuery, {
        itemSelector: (_item, itemPayload) => itemPayload,
      });

      return query.items.map((itemPayload) => (
        <Row
          key={itemPayload}
          itemPayload={itemPayload}
        />
      ));
    }

    return render(<UsersList />);
  }

  function renameUserOffline(env: UsersEnv, itemId: string, name: string) {
    return act(async () => {
      await env.apiStore.performMutation(itemId, {
        optimisticUpdate: () => {
          env.apiStore.updateItemState(itemId, (item) => ({ ...item, name }));
        },
        mutation: async () => {
          await env.serverTable.delayedUpdateItem(itemId, { name });
          return { name };
        },
        offline: { operation: 'patchUserName', input: { itemId, name } },
      });
    });
  }

  test('a row edited offline shows it is waiting, then syncing, then synced, without re-rendering the other rows', async () => {
    const env = createUsersEnv('item-offline-state-edit-session');
    const renders = createRenderLog();

    const list = renderUsersList(env, renders);
    await flushAllTimers();

    renders.addMark('offline: rename Ada');
    act(() => {
      network.goOffline();
    });
    await flushAllTimers();
    await renameUserOffline(env, 'users||1', 'Ada Lovelace');

    // A second edit of the same row adds to its pending mutations count.
    renders.addMark('offline: rename Ada again, then rename Grace');
    await renameUserOffline(env, 'users||1', 'Ada King');
    await renameUserOffline(env, 'users||2', 'Grace Hopper');

    // Imperative code (e.g. an event handler) reads the same state without
    // subscribing.
    expect({
      editedTwice: env.apiStore.getItemOfflineState('users||1'),
      editedOnce: env.apiStore.getItemOfflineState('users||2'),
      untouched: env.apiStore.getItemOfflineState('users||3'),
    }).toMatchInlineSnapshot(`
      editedOnce:
        creationAttempted: '❌'
        isUnsentCreation: '❌'
        pendingMutations: 1
        requiresResolution: '❌'
        syncState: 'pending'

      editedTwice:
        creationAttempted: '❌'
        isUnsentCreation: '❌'
        pendingMutations: 2
        requiresResolution: '❌'
        syncState: 'pending'

      untouched: null
    `);

    // The queue replays one mutation at a time, in the order they were made:
    // Ada's two renames, then Grace's.
    renders.addMark('back online: the three renames replay in order');
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // - Each row re-renders only when its own state changes. Linus renders a
    //   single time (on mount), even though the store's offline entities
    //   changed on every step of the other rows' queueing and replay.
    // - Grace goes pending -> syncing -> synced (null).
    // - With several mutations queued for a row, `syncState` is the most
    //   urgent one among them: Ada is `syncing` while her first rename is
    //   sent, `pending` again once only the second one is left waiting, then
    //   `syncing` while it is sent.
    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      -> row: users||1 ⋅ offlineState: null
      -> row: users||2 ⋅ offlineState: null
      -> row: users||3 ⋅ offlineState: null

      >>> offline: rename Ada

      -> row: users||1 ⋅ offlineState: {syncState:pending, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}

      >>> offline: rename Ada again, then rename Grace

      -> row: users||1 ⋅ offlineState: {syncState:pending, pendingMutations:2, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> row: users||2 ⋅ offlineState: {syncState:pending, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}

      >>> back online: the three renames replay in order

      -> row: users||1 ⋅ offlineState: {syncState:syncing, pendingMutations:2, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> row: users||1 ⋅ offlineState: {syncState:pending, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> row: users||1 ⋅ offlineState: {syncState:syncing, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> row: users||1 ⋅ offlineState: null
      -> row: users||2 ⋅ offlineState: {syncState:syncing, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> row: users||2 ⋅ offlineState: null
      "
    `);
    expect(env.apiStore.getItemOfflineState('users||1')).toBeNull();

    list.unmount();
  });

  test('a row whose edit keeps being rejected asks for attention until the user discards the edit', async () => {
    const env = createUsersEnv('item-offline-state-resolution-session', [
      'Grace (rejected)',
    ]);
    const renders = createRenderLog();

    const list = renderUsersList(env, renders);
    await flushAllTimers();

    renders.addMark('offline: rename Grace to a name the server rejects');
    act(() => {
      network.goOffline();
    });
    await flushAllTimers();
    await renameUserOffline(env, 'users||2', 'Grace (rejected)');

    // The replay is retried 3 times (5s apart) before giving up.
    renders.addMark('back online: every replay attempt is rejected');
    act(() => {
      network.goOnline();
    });
    await withSuppressedActError(async () => {
      await flushAllTimers();
    });

    // Nothing is left to sync by itself: the row needs a manual resolution.
    expect(env.apiStore.getItemOfflineState('users||2')).toMatchInlineSnapshot(`
      creationAttempted: '❌'
      isUnsentCreation: '❌'
      pendingMutations: 0
      requiresResolution: '✅'
      syncState: 'resolution-required'
    `);

    renders.addMark('the user discards the rejected edit');
    const [resolution] = env.apiStore.getOfflineResolutions();
    if (!resolution) throw new Error('Expected a resolution for Grace');
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        resolution.id,
        'patchUserName',
        { action: 'discard' },
      );
    });
    await flushAllTimers();

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      -> row: users||1 ⋅ offlineState: null
      -> row: users||2 ⋅ offlineState: null
      -> row: users||3 ⋅ offlineState: null

      >>> offline: rename Grace to a name the server rejects

      -> row: users||2 ⋅ offlineState: {syncState:pending, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}

      >>> back online: every replay attempt is rejected

      -> row: users||2 ⋅ offlineState: {syncState:syncing, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> row: users||2 ⋅ offlineState: {syncState:needs-confirmation, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> row: users||2 ⋅ offlineState: {syncState:syncing, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> row: users||2 ⋅ offlineState: {syncState:needs-confirmation, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> row: users||2 ⋅ offlineState: {syncState:syncing, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> row: users||2 ⋅ offlineState: {syncState:resolution-required, pendingMutations:0, requiresResolution:✅, isUnsentCreation:❌, creationAttempted:❌}

      >>> the user discards the rejected edit

      -> row: users||2 ⋅ offlineState: null
      "
    `);

    list.unmount();
  });

  test('a row created offline is an unsent creation until the server assigns its id, then the final row reports the edits still replaying', async () => {
    const env = createUsersEnv('item-offline-state-creation-session');
    const renders = createRenderLog();

    const list = renderUsersList(env, renders);
    await flushAllTimers();

    renders.addMark('offline: create Margaret');
    act(() => {
      network.goOffline();
    });
    await flushAllTimers();
    await act(async () => {
      await env.apiStore.performMutation('temp:Margaret', {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            'temp:Margaret',
            { id: -1, name: 'Margaret' },
            { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
          );
        },
        mutation: async () => {
          const result = { id: 4, name: 'Margaret' };
          await env.serverTable.delayedSetItem('users||4', result);
          return result;
        },
        offline: { operation: 'createUser', input: { name: 'Margaret' } },
      });
    });

    renders.addMark('offline: rename the row that was just created');
    await renameUserOffline(env, 'temp:Margaret', 'Margaret Hamilton');

    // A delete handler can tell that the server never saw this row (deleting
    // it only has to cancel the queued creation), unlike a row edited offline.
    await renameUserOffline(env, 'users||1', 'Ada Lovelace');
    expect({
      createdOffline: env.apiStore.getItemOfflineState('temp:Margaret'),
      editedOffline: env.apiStore.getItemOfflineState('users||1'),
    }).toMatchInlineSnapshot(`
      createdOffline:
        creationAttempted: '❌'
        isUnsentCreation: '✅'
        pendingMutations: 2
        requiresResolution: '❌'
        syncState: 'pending'

      editedOffline:
        creationAttempted: '❌'
        isUnsentCreation: '❌'
        pendingMutations: 1
        requiresResolution: '❌'
        syncState: 'pending'
    `);

    // Replay order: the creation, then the rename of the created row (now
    // targeting its server id), then Ada's rename.
    renders.addMark('back online: the creation replays, then the renames');
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // - While the creation is sent, the temp row reports `syncing`, still as
    //   an unsent creation with the rename queued behind it, and as attempted:
    //   from here on a delete handler cannot assume that the server never saw
    //   the row.
    // - Once the server assigns `users||4`, the list swaps the temp row for the
    //   final one. It mounts before the queued rename is moved to the new id
    //   (first `null`), then reports that rename until it is synced, no longer
    //   as an unsent creation.
    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      -> row: users||1 ⋅ offlineState: null
      -> row: users||2 ⋅ offlineState: null
      -> row: users||3 ⋅ offlineState: null

      >>> offline: create Margaret

      -> row: temp:Margaret ⋅ offlineState: null
      -> row: temp:Margaret ⋅ offlineState: {syncState:pending, pendingMutations:1, requiresResolution:❌, isUnsentCreation:✅, creationAttempted:❌}

      >>> offline: rename the row that was just created

      -> row: temp:Margaret ⋅ offlineState: {syncState:pending, pendingMutations:2, requiresResolution:❌, isUnsentCreation:✅, creationAttempted:❌}
      -> row: users||1 ⋅ offlineState: {syncState:pending, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}

      >>> back online: the creation replays, then the renames

      -> row: temp:Margaret ⋅ offlineState: {syncState:syncing, pendingMutations:2, requiresResolution:❌, isUnsentCreation:✅, creationAttempted:✅}
      -> row: users||4 ⋅ offlineState: null
      -> row: users||4 ⋅ offlineState: {syncState:pending, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> row: users||4 ⋅ offlineState: {syncState:syncing, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> row: users||4 ⋅ offlineState: null
      -> row: users||1 ⋅ offlineState: {syncState:syncing, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> row: users||1 ⋅ offlineState: null
      "
    `);
    // Everything is synced: neither payload has offline work left.
    expect({
      tempPayload: env.apiStore.getItemOfflineState('temp:Margaret'),
      finalPayload: env.apiStore.getItemOfflineState('users||4'),
    }).toMatchInlineSnapshot(`
      finalPayload: null
      tempPayload: null
    `);

    list.unmount();
  });

  test('rows of a store without offline support never report an offline state', async () => {
    const env = createListQueryStoreTestEnv(
      { users: [{ id: 1, name: 'Ada' }] },
      { testScenario: { loaded: { queries: [usersQuery] } } },
    );

    const hook = renderHook(() => ({
      row: env.apiStore.useItemOfflineState('users||1'),
      // Falsy payloads are accepted like in `useItem`, e.g. no row selected.
      noRow: env.apiStore.useItemOfflineState(null),
    }));
    await flushAllTimers();

    expect({
      hook: hook.result.current,
      getter: env.apiStore.getItemOfflineState('users||1'),
    }).toMatchInlineSnapshot(`
      getter: null
      hook: { noRow: null, row: null }
    `);

    hook.unmount();
  });
});

describe('collection items', () => {
  type UserItem = { name: string };
  type UsersOperations = CreateUserOperations & {
    renameUser: CollectionOfflineOperationDefinition<
      { value: UserItem },
      string,
      { itemId: string; name: string },
      unknown
    >;
  };
  type UsersEnv = ReturnType<
    typeof createCollectionStoreTestEnv<UserItem, UsersOperations>
  >;

  /**
   * A users collection that can create and rename users offline. Renames
   * whose new name is in `rejectedNames` are always refused by the server.
   */
  function createUsersEnv(
    sessionKey: string,
    rejectedNames: readonly string[] = [],
  ): UsersEnv {
    const env: UsersEnv = createCollectionStoreTestEnv<
      UserItem,
      UsersOperations
    >(
      {
        'users||1': { name: 'Ada' },
        'users||2': { name: 'Grace' },
        'users||3': { name: 'Linus' },
      },
      {
        getSessionKey: () => sessionKey,
        storeManager: createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey: () => sessionKey,
          offlineSession: {
            network: network.config,
            classifyRetryableFailure: (error, ctx) =>
              classifyRetryableReplayFailure(error, ctx.phase),
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
                    value: { name: input.name },
                  }),
                  reconcileServerEntity: (result) => ({
                    finalPayload: result.id,
                    finalData: { value: { name: result.name } },
                  }),
                },
                execute: async ({ input }) => {
                  const result = { id: 'users||4', name: input.name };
                  await env.serverTable.delayedSetItem(result.id, {
                    name: result.name,
                  });
                  return result;
                },
              },
              renameUser: {
                inputSchema: userPatchSchema,
                kind: 'update',
                getEntityRefs: ({ input }) => [input.itemId],
                execute: async ({ input }) => {
                  if (rejectedNames.includes(input.name)) {
                    throw new Error('rename rejected by the server');
                  }

                  await env.serverTable.delayedUpdateItem(input.itemId, {
                    name: input.name,
                  });
                  return { value: { name: input.name } };
                },
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateItemState(input.itemId, (draft) => {
                    draft.value.name = input.name;
                  });
                },
              },
            },
          },
        },
      },
    );

    return env;
  }

  /** One mounted component per item, each logging its own renders. */
  function renderItems(
    env: UsersEnv,
    renders: RenderLog,
    itemPayloads: readonly string[],
  ) {
    const hooks = itemPayloads.map((itemPayload) =>
      renderHook(() => {
        const offlineState = env.apiStore.useItemOfflineState(itemPayload);

        renders.add({ item: itemPayload, offlineState });
      }),
    );

    return {
      unmount: () => {
        for (const hook of hooks) hook.unmount();
      },
    };
  }

  function renameUserOffline(env: UsersEnv, itemId: string, name: string) {
    return act(async () => {
      await env.apiStore.performMutation(itemId, {
        optimisticUpdate: () => {
          env.apiStore.updateItemState(itemId, (draft) => {
            draft.value.name = name;
          });
        },
        mutation: async () => {
          await env.serverTable.delayedUpdateItem(itemId, { name });
          return { value: { name } };
        },
        offline: { operation: 'renameUser', input: { itemId, name } },
      });
    });
  }

  test('each item reports its own offline state: synced edits clear, rejected edits ask for attention, untouched items never re-render', async () => {
    const env = createUsersEnv('collection-item-offline-state-session', [
      'Grace (rejected)',
    ]);
    const renders = createRenderLog();

    const items = renderItems(env, renders, [
      'users||1',
      'users||2',
      'users||3',
    ]);
    await flushAllTimers();

    renders.addMark('offline: rename Ada, and Grace to a rejected name');
    act(() => {
      network.goOffline();
    });
    await flushAllTimers();
    await renameUserOffline(env, 'users||1', 'Ada Lovelace');
    await renameUserOffline(env, 'users||2', 'Grace (rejected)');

    // Ada's rename syncs; Grace's is retried 3 times (5s apart) and then
    // waits for a manual resolution.
    renders.addMark('back online: Ada syncs, Grace is rejected');
    act(() => {
      network.goOnline();
    });
    await withSuppressedActError(async () => {
      await flushAllTimers();
    });

    // Linus renders a single time (on mount): the other items' changes never
    // reach it.
    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      -> item: users||1 ⋅ offlineState: null
      -> item: users||2 ⋅ offlineState: null
      -> item: users||3 ⋅ offlineState: null

      >>> offline: rename Ada, and Grace to a rejected name

      -> item: users||1 ⋅ offlineState: {syncState:pending, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> item: users||2 ⋅ offlineState: {syncState:pending, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}

      >>> back online: Ada syncs, Grace is rejected

      -> item: users||1 ⋅ offlineState: {syncState:syncing, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> item: users||1 ⋅ offlineState: null
      -> item: users||2 ⋅ offlineState: {syncState:syncing, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> item: users||2 ⋅ offlineState: {syncState:needs-confirmation, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> item: users||2 ⋅ offlineState: {syncState:syncing, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> item: users||2 ⋅ offlineState: {syncState:needs-confirmation, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> item: users||2 ⋅ offlineState: {syncState:syncing, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> item: users||2 ⋅ offlineState: {syncState:resolution-required, pendingMutations:0, requiresResolution:✅, isUnsentCreation:❌, creationAttempted:❌}
      "
    `);
    expect({
      synced: env.apiStore.getItemOfflineState('users||1'),
      rejected: env.apiStore.getItemOfflineState('users||2'),
      untouched: env.apiStore.getItemOfflineState('users||3'),
    }).toMatchInlineSnapshot(`
      rejected:
        creationAttempted: '❌'
        isUnsentCreation: '❌'
        pendingMutations: 0
        requiresResolution: '✅'
        syncState: 'resolution-required'

      synced: null
      untouched: null
    `);

    items.unmount();
  });

  test('an item created offline is an unsent creation until the server assigns its id, then the final item reports the edits still replaying', async () => {
    const env = createUsersEnv('collection-item-offline-state-creation');
    const renders = createRenderLog();

    // The app keeps showing the created item under its temp payload until the
    // server id (`users||4`) is known, then under the final one.
    const items = renderItems(env, renders, ['temp:Margaret', 'users||4']);
    await flushAllTimers();

    renders.addMark('offline: create Margaret, then rename her');
    act(() => {
      network.goOffline();
    });
    await flushAllTimers();
    await act(async () => {
      await env.apiStore.performMutation(null, {
        mutation: async () => {
          const result = { id: 'users||4', name: 'Margaret' };
          await env.serverTable.delayedSetItem(result.id, {
            name: result.name,
          });
          return result;
        },
        offline: { operation: 'createUser', input: { name: 'Margaret' } },
      });
    });
    await renameUserOffline(env, 'temp:Margaret', 'Margaret Hamilton');

    // A delete handler can tell that the server never saw this item.
    expect(env.apiStore.getItemOfflineState('temp:Margaret'))
      .toMatchInlineSnapshot(`
        creationAttempted: '❌'
        isUnsentCreation: '✅'
        pendingMutations: 2
        requiresResolution: '❌'
        syncState: 'pending'
      `);

    renders.addMark('back online: the creation replays, then the rename');
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // - While the creation is sent, the temp item reports `syncing`, still as
    //   an unsent creation with the rename queued behind it, and as attempted:
    //   the server may know the item from here on.
    // Once the server assigns `users||4`:
    // - the queued rename moves to the final payload, which reports it until
    //   it is synced, no longer as an unsent creation
    // - the temp payload is left with only the creation that is finishing,
    //   and then has no offline state anymore (`null`)
    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      -> item: temp:Margaret ⋅ offlineState: null
      -> item: users||4 ⋅ offlineState: null

      >>> offline: create Margaret, then rename her

      -> item: temp:Margaret ⋅ offlineState: {syncState:pending, pendingMutations:1, requiresResolution:❌, isUnsentCreation:✅, creationAttempted:❌}
      -> item: temp:Margaret ⋅ offlineState: {syncState:pending, pendingMutations:2, requiresResolution:❌, isUnsentCreation:✅, creationAttempted:❌}

      >>> back online: the creation replays, then the rename

      -> item: temp:Margaret ⋅ offlineState: {syncState:syncing, pendingMutations:2, requiresResolution:❌, isUnsentCreation:✅, creationAttempted:✅}
      -> item: users||4 ⋅ offlineState: {syncState:pending, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> item: temp:Margaret ⋅ offlineState: {syncState:syncing, pendingMutations:1, requiresResolution:❌, isUnsentCreation:✅, creationAttempted:✅}
      -> item: temp:Margaret ⋅ offlineState: null
      -> item: users||4 ⋅ offlineState: {syncState:syncing, pendingMutations:1, requiresResolution:❌, isUnsentCreation:❌, creationAttempted:❌}
      -> item: users||4 ⋅ offlineState: null
      "
    `);

    items.unmount();
  });
});
