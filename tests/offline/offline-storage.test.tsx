import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { PartialResourcesConfig } from '../../src/listQueryStore/types';
import {
  clearSessionStorage,
  createOfflineSession,
  type ListQueryOfflineOperationDefinition,
} from '../../src/main';
import { __resetSessionOfflineCoordinatorRegistryForTests } from '../../src/persistentStorage/offline/sessionCoordinator';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { resetMockBrowserOpfsForTests } from '../mocks/mockBrowserOpfs';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { createOpfsPersistentStorageTestStore } from '../utils/opfsPersistentStorageTestStore';
import {
  getLocalStorageTree,
  getOpfsDirTree,
  getParsedLocalStorageValue,
  getParsedOpfsFileData,
} from '../utils/persistentStorageOptimizationTestUtils';
import {
  type CreateListQueryUserOperations,
  deleteItemInputSchema,
  type UpdateValueOperations,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  collectionCreateInputSchema,
  docMutationInputSchema,
  docSchema,
  getGlobalOfflineStatusSummary,
  listQueryQueryPayloadSchema,
} from './offlineTestShared';

let network = createOfflineNetworkMock();

const offlineStorageUsersQuery = { tableId: 'users' } as const;

type OfflineStorageUserRow = { id: number; name: string };

const offlineStorageUsersTable: { users: OfflineStorageUserRow[] } = {
  users: [
    { id: 1, name: 'Ada' },
    { id: 2, name: 'Grace' },
  ],
};

const partialResourcesConfig: PartialResourcesConfig<OfflineStorageUserRow> = {
  mergeItems: (prev, fetched) => {
    if (!prev) return fetched;
    return { ...prev, ...fetched };
  },
  selectFields: (fields, item) => {
    const result: Record<string, unknown> = {};

    for (const field of fields) {
      if (field in item) {
        result[field] =
          item[__LEGIT_CAST__<keyof OfflineStorageUserRow, string>(field)];
      }
    }

    return __LEGIT_CAST__<OfflineStorageUserRow, Record<string, unknown>>(
      result,
    );
  },
};

function createOfflineDocumentEnv({
  adapter,
  sessionKey,
  storeName,
  testScenario,
  onExecute,
}: {
  adapter: 'local-sync' | typeof opfsPersistentStorage;
  sessionKey: string;
  storeName: string;
  testScenario: 'idle' | 'loaded';
  onExecute?: (input: { value: number }) => void;
}) {
  const envRef: {
    current: ReturnType<
      typeof createDocumentStoreTestEnv<number, UpdateValueOperations>
    > | null;
  } = { current: null };

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: storeName,
    getSessionKey: () => sessionKey,
    testScenario,
    persistentStorage: {
      adapter,
      schema: docSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () => sessionKey,
          config: { network: network.config },
        }),
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            execute: async ({ input }) => {
              onExecute?.(input);
              await envRef.current?.serverMock.delayedSetData(input.value);
              return input;
            },
            onSuccessExecute: ({ input }) => {
              envRef.current?.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
            },
          },
        },
      },
    },
  });

  envRef.current = env;

  return env;
}

function createOfflinePartialListQueryEnv({
  sessionKey,
  storeName,
  testScenario = 'idle',
  nextUserIdRef,
}: {
  sessionKey: string;
  storeName: string;
  testScenario?: 'idle' | { loaded: { queries: { tableId: string }[] } };
  nextUserIdRef: { current: number };
}) {
  const env = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    true,
    false,
    CreateListQueryUserOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    getSessionKey: () => sessionKey,
    testScenario,
    partialResources: partialResourcesConfig,
    persistentStorage: {
      adapter: 'local-sync',
      schema: userRowSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: listQueryQueryPayloadSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () => sessionKey,
          config: { network: network.config },
        }),
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
              const data = { id: nextUserIdRef.current, name: input.name };
              nextUserIdRef.current += 1;
              await env.serverTable.delayedSetItem(`users||${data.id}`, data);
              return data;
            },
          },
        },
      },
    },
  });

  return env;
}

type OfflinePendingItemsOperations = {
  patchUserName: ListQueryOfflineOperationDefinition<
    OfflineStorageUserRow,
    ListQueryParams,
    string,
    { itemId: string; name: string },
    unknown
  >;
  deleteUser: ListQueryOfflineOperationDefinition<
    OfflineStorageUserRow,
    ListQueryParams,
    string,
    { itemId: string },
    unknown
  >;
};

function createOfflinePendingItemsListQueryEnv({
  adapter,
  sessionKey,
  storeName,
  testScenario = 'idle',
}: {
  adapter: 'local-sync' | typeof opfsPersistentStorage;
  sessionKey: string;
  storeName: string;
  testScenario?: 'idle' | { loaded: { queries: { tableId: string }[] } };
}) {
  const env = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    OfflinePendingItemsOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    getSessionKey: () => sessionKey,
    testScenario,
    persistentStorage: {
      adapter,
      schema: userRowSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: listQueryQueryPayloadSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () => sessionKey,
          config: { network: network.config },
        }),
        operations: {
          patchUserName: {
            inputSchema: userPatchSchema,
            kind: 'update',
            getEntityRefs: ({ input }) => [input.itemId],
            execute: async ({ input }) => {
              await env.serverTable.delayedSetItem(input.itemId, {
                id: Number(input.itemId.split('||')[1]),
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
          deleteUser: {
            inputSchema: deleteItemInputSchema,
            kind: 'delete',
            getEntityRefs: ({ input }) => [input.itemId],
            execute: async ({ input }) => {
              await env.serverTable.delayedRemoveItem(input.itemId);
            },
            onSuccessExecute: ({ input }) => {
              env.apiStore.deleteItemState(input.itemId);
            },
          },
        },
      },
    },
  });

  return env;
}

beforeEach(() => {
  __resetSessionOfflineCoordinatorRegistryForTests();
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  network = createOfflineNetworkMock();
  network.install();
  localStorage.clear();
  resetMockBrowserOpfsForTests();
  opfsPersistentStorage.resetForTests?.();
});

afterEach(() => {
  __resetSessionOfflineCoordinatorRegistryForTests();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  localStorage.clear();
  resetMockBrowserOpfsForTests();
  opfsPersistentStorage.resetForTests?.();
});

test('local-sync offline persistence keeps the raw localStorage keys and JSON payloads transparent', async () => {
  const sessionKey = 'offline-sync-format-session';
  const storeName = 'offline-sync-format-doc';
  const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.123456789);

  try {
    // Start fully offline so both the session status snapshot and the queued
    // mutation are persisted through the real offline flow.
    network.setOffline();

    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => sessionKey,
            config: { network: network.config },
          }),
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

    await Promise.resolve();

    // Queue one optimistic mutation so the document entry, the queue entry, the
    // offline entity summary, and the session status all have to be stored.
    await resolveAfterAllTimers(
      env.apiStore.performMutation({
        optimisticUpdate: () => {
          env.apiStore.updateState((draft) => {
            draft.value = 2;
          });
        },
        mutation: async () => {
          await env.serverMock.delayedSetData(2);
          return 2;
        },
        offline: { operation: 'updateValue', input: { value: 2 } },
      }),
    );
    await flushAllTimers();

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (1.45 kb)
      ├ _m (0.64 kb)
      │ ├ g (0.04 kb)
      │ └ r (0.59 kb)
      │   ├ n:offline-sync-format-session.offline-sync-format-doc (0.34 kb)
      │   │ ├ oe.m (0.08 kb)
      │   │ └ oq.m (0.15 kb)
      │   └ s:offline-sync-format-session (0.25 kb)
      │     ├ _o_.s.m (0.07 kb)
      │     └ offline-sync-format-doc.m (0.13 kb)
      └ offline-sync-format-session (0.81 kb)
        ├ _o_.s (0.09 kb)
        └ offline-sync-format-doc (0.66 kb)
          ├ oe.document (0.18 kb)
          └ oq.offline-sync-format-doc:1735689600000:4fzzzxjy (0.40 kb)"
    `);

    expect(
      getParsedLocalStorageValue(
        'tsdf._m.r.s:offline-sync-format-session._o_.s.m',
      ),
    ).toMatchInlineSnapshot(`
      e:
        d: { a: 1735689600000 }
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf._m.r.s:offline-sync-format-session.offline-sync-format-doc.m',
      ),
    ).toMatchInlineSnapshot(`
      e:
        d: { a: 1735689601000, o: '✅' }
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf._m.r.n:offline-sync-format-session.offline-sync-format-doc.oe.m',
      ),
    ).toMatchInlineSnapshot(`
      e:
        document: { a: 1735689600000 }
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf._m.r.n:offline-sync-format-session.offline-sync-format-doc.oq.m',
      ),
    ).toMatchInlineSnapshot(`
      e:
        offline-sync-format-doc:1735689600000:4fzzzxjy: { a: 1735689600000 }
    `);
    expect(getParsedLocalStorageValue('tsdf.offline-sync-format-session._o_.s'))
      .toMatchInlineSnapshot(`
        d:
          n: { a: 1, e: 1 }
          u: 1735689600000
      `);
    expect(
      getParsedLocalStorageValue(
        'tsdf.offline-sync-format-session.offline-sync-format-doc',
      ),
    ).toMatchInlineSnapshot(`
      d: { value: 2 }
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf.offline-sync-format-session.offline-sync-format-doc.oe.document',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689600000
      g: 'd'
      h: 'u'
      k: 'document'
      p: 1
      s: 'p'
      u: 1735689600000
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf.offline-sync-format-session.offline-sync-format-doc.oq.offline-sync-format-doc:1735689600000:4fzzzxjy',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689600000
      d: 'offline-sync-format-doc:1735689600000:4fzzzxjy'
      e: ['d:document']
      i: { value: 2 }
      o: 'updateValue'
      s: 'p'
      u: 1735689600000
      w: 'd'
    `);
  } finally {
    randomSpy.mockRestore();
  }
});

test('local-sync offline persistence rehydrates queued data in a new browser session and replays it once the browser is back online', async () => {
  const sessionKey = 'offline-sync-restart-session';
  const storeName = 'offline-sync-restart-doc';

  network.setOffline();

  const firstEnv = createOfflineDocumentEnv({
    adapter: 'local-sync',
    sessionKey,
    storeName,
    testScenario: 'loaded',
  });

  await resolveAfterAllTimers(
    firstEnv.apiStore.performMutation({
      optimisticUpdate: () => {
        firstEnv.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: async () => {
        await firstEnv.serverMock.delayedSetData(2);
        return 2;
      },
      offline: { operation: 'updateValue', input: { value: 2 } },
    }),
  );
  await flushAllTimers();

  // Simulate a fresh browser session booting with only persisted storage.
  __resetSessionOfflineCoordinatorRegistryForTests();

  const restartedEnv = createOfflineDocumentEnv({
    adapter: 'local-sync',
    sessionKey,
    storeName,
    testScenario: 'idle',
  });
  const hook = renderHook(() =>
    restartedEnv.apiStore.useDocument({ returnRefetchingStatus: true }),
  );

  await flushAllTimers();

  expect(hook.result.current).toMatchInlineSnapshot(`
    data: { value: 2 }
    error: null
    isLoading: '❌'
    pendingSync: '✅'
    status: 'success'
  `);
  expect(
    restartedEnv.apiStore
      .getOfflineEntities()
      .map((entity) => ({
        entityKey: entity.entityKey,
        pendingMutations: entity.pendingMutations,
        syncState: entity.syncState,
      })),
  ).toMatchInlineSnapshot(`
    - { entityKey: 'document', pendingMutations: 1, syncState: 'pending' }
  `);

  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(hook.result.current).toMatchInlineSnapshot(`
    data: { value: 2 }
    error: null
    isLoading: '❌'
    pendingSync: '❌'
    status: 'success'
  `);
  expect(restartedEnv.apiStore.getOfflineEntities()).toMatchInlineSnapshot(
    `[]`,
  );

  hook.unmount();
});

test('local-sync offline persistence replays queued data when a new browser session boots already online', async () => {
  const sessionKey = 'offline-sync-online-restart-session';
  const storeName = 'offline-sync-online-restart-doc';
  const replayedInputs: { value: number }[] = [];

  network.setOffline();

  const firstEnv = createOfflineDocumentEnv({
    adapter: 'local-sync',
    sessionKey,
    storeName,
    testScenario: 'loaded',
  });

  await resolveAfterAllTimers(
    firstEnv.apiStore.performMutation({
      optimisticUpdate: () => {
        firstEnv.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: async () => {
        await firstEnv.serverMock.delayedSetData(2);
        return 2;
      },
      offline: { operation: 'updateValue', input: { value: 2 } },
    }),
  );
  await flushAllTimers();

  // Simulate reopening the app after connectivity recovered elsewhere.
  __resetSessionOfflineCoordinatorRegistryForTests();
  act(() => {
    network.goOnline();
  });

  const restartedEnv = createOfflineDocumentEnv({
    adapter: 'local-sync',
    sessionKey,
    storeName,
    testScenario: 'idle',
    onExecute: (input) => {
      replayedInputs.push(input);
    },
  });
  const hook = renderHook(() =>
    restartedEnv.apiStore.useDocument({ returnRefetchingStatus: true }),
  );

  await flushAllTimers();

  expect(replayedInputs).toMatchInlineSnapshot(`
    - value: 2
  `);
  expect(hook.result.current).toMatchInlineSnapshot(`
    data: { value: 2 }
    error: null
    isLoading: '❌'
    pendingSync: '❌'
    status: 'success'
  `);
  expect(restartedEnv.apiStore.getOfflineEntities()).toMatchInlineSnapshot(
    `[]`,
  );

  hook.unmount();
});

test('local-sync restart keeps offline temp rows visible for partial-resource list queries', async () => {
  const sessionKey = 'offline-list-partial-temp-session';
  const storeName = 'offline-list-partial-temp-store';
  const nextUserIdRef = { current: 3 };
  const firstEnv = createOfflinePartialListQueryEnv({
    sessionKey,
    storeName,
    nextUserIdRef,
  });

  // Start from a real partial-resource query load so persistence stores the
  // requested fields for the server rows before the offline temp row is added.
  const seedHook = renderHook(() =>
    firstEnv.apiStore.useListQuery(offlineStorageUsersQuery, {
      fields: ['id', 'name'],
      itemSelector: (item) => item.name,
      returnRefetchingStatus: true,
    }),
  );
  await flushAllTimers();
  await advanceTime(1100);
  await flushAllTimers();

  expect({
    items: seedHook.result.current.items,
    status: seedHook.result.current.status,
  }).toMatchInlineSnapshot(`
    items: ['Ada', 'Grace']
    status: 'success'
  `);
  seedHook.unmount();

  // Move offline before queueing the create so the temp row only exists in the
  // persisted offline queue and fallback item/query snapshots.
  act(() => {
    network.goOffline();
  });
  await flushAllTimers();

  // Queue a temp create while offline. The optimistic row has the requested
  // fields on the item object, but it never records `loadedFields` metadata.
  firstEnv.addTimelineComments('beforeNextAction', [
    'go offline and queue a temp create; the optimistic row has data but no loadedFields metadata',
  ]);
  await act(async () => {
    await firstEnv.apiStore.performMutation(null, {
      optimisticUpdate: () => {
        firstEnv.apiStore.addItemToState(
          'temp:Linus offline',
          { id: -1, name: 'Linus offline' },
          {
            addItemToQueries: {
              queries: [offlineStorageUsersQuery],
              appendTo: 'end',
            },
          },
        );
      },
      mutation: async () => {
        const data = { id: 3, name: 'Linus offline' };
        await firstEnv.serverTable.delayedSetItem('users||3', data);
        return data;
      },
      offline: { operation: 'createUser', input: { name: 'Linus offline' } },
    });
  });
  await flushAllTimers();

  expect(firstEnv.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    10ms  | 🔴 >list-fetch-started
    810ms | 🔴 <list-fetch-finished (value: {"count":2})
    2.91s | -- go offline and queue a temp create; the optimistic row has data but no loadedFields metadata
    .     | offline:createUser queued
    "
  `);

  // Reboot the app while the temp row only exists through persisted fallback
  // state plus offline entity metadata.
  __resetSessionOfflineCoordinatorRegistryForTests();

  const restartedEnv = createOfflinePartialListQueryEnv({
    sessionKey,
    storeName,
    testScenario: 'idle',
    nextUserIdRef,
  });

  // Mount the restarted UI while still offline. The query and standalone item
  // hooks should reuse the persisted temp row immediately.
  restartedEnv.addTimelineComments('beforeNextAction', [
    'restart the app offline; both hooks should reuse the persisted temp row immediately',
  ]);
  const hook = renderHook(() => {
    const query = restartedEnv.apiStore.useListQuery(offlineStorageUsersQuery, {
      fields: ['id', 'name'],
      itemSelector: (item) => item.name,
      disableRefetchOnMount: true,
      returnRefetchingStatus: true,
    });
    restartedEnv.trackItemUI('query-status', query.status);
    restartedEnv.trackItemUI('query-items', query.items.join(', '));

    const tempItem = restartedEnv.apiStore.useItem('temp:Linus offline', {
      fields: ['id', 'name'],
      selector: (item) => item?.name ?? null,
      disableRefetchOnMount: true,
      returnRefetchingStatus: true,
    });
    restartedEnv.trackItemUI('temp-item-status', tempItem.status);
    restartedEnv.trackItemUI('temp-item-data', tempItem.data ?? 'null');

    return { query, tempItem };
  });
  await act(async () => {
    await Promise.resolve();
  });

  expect({
    queryItems: hook.result.current.query.items,
    queryStatus: hook.result.current.query.status,
    tempItemData: hook.result.current.tempItem.data,
    tempItemStatus: hook.result.current.tempItem.status,
  }).toMatchInlineSnapshot(`
    queryItems: ['Ada', 'Grace', 'Linus offline']
    queryStatus: 'success'
    tempItemData: 'Linus offline'
    tempItemStatus: 'success'
  `);
  expect(
    restartedEnv.apiStore
      .getOfflineEntities()
      .map((entity) => ({
        entityKey: entity.entityKey,
        pendingMutations: entity.pendingMutations,
        syncState: entity.syncState,
      })),
  ).toMatchInlineSnapshot(`
    - entityKey: '"temp:Linus offline'
      pendingMutations: 1
      syncState: 'pending'
  `);
  expect(restartedEnv.timelineString).toMatchInlineSnapshot(`
    "
    time | query-items               | query-status | temp-item-data | temp-item-status |
    0    | -                         | -            | -              | -                | -- restart the app offline; both hooks should reuse the persisted temp row immediately
    .    | Ada, Grace, Linus offline | success      | Linus offline  | success          | [query-status, query-items, temp-item-status, temp-item-data] ui-initialized
    "
  `);

  hook.unmount();
});

test('local-sync idle offline boot hydrates pending offline items from storage without a list query mount', async () => {
  const sessionKey = 'offline-sync-pending-items-session';
  const storeName = 'offline-sync-pending-items-store';

  const firstEnv = createOfflinePendingItemsListQueryEnv({
    adapter: 'local-sync',
    sessionKey,
    storeName,
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
  });

  // Queue the offline work while the list is already loaded so the restart can
  // rely entirely on persisted offline metadata plus item storage snapshots.
  act(() => {
    network.goOffline();
  });
  await flushAllTimers();

  // Keep one row visible as a pending edit.
  await act(async () => {
    await firstEnv.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        firstEnv.apiStore.updateItemState('users||1', (item) => ({
          ...item,
          name: 'Ada queued',
        }));
      },
      mutation: async () => {
        await firstEnv.serverTable.delayedSetItem('users||1', {
          id: 1,
          name: 'Ada queued',
        });
        return { name: 'Ada queued' };
      },
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada queued' },
      },
    });
  });

  // Delete another row so the hook has to restore the deleted payload from the
  // offline entity metadata rather than from a mounted query.
  await act(async () => {
    await firstEnv.apiStore.performMutation('users||2', {
      optimisticUpdate: () => {
        firstEnv.apiStore.deleteItemState('users||2');
      },
      mutation: async () => {
        await firstEnv.serverTable.delayedRemoveItem('users||2');
      },
      offline: { operation: 'deleteUser', input: { itemId: 'users||2' } },
    });
  });
  await flushAllTimers();

  // Restart the app into a fresh idle store while the browser is still offline.
  __resetSessionOfflineCoordinatorRegistryForTests();

  const restartedEnv = createOfflinePendingItemsListQueryEnv({
    adapter: 'local-sync',
    sessionKey,
    storeName,
    testScenario: 'idle',
  });

  restartedEnv.addTimelineComments('beforeNextAction', [
    'restart offline and mount only usePendingOfflineItems; it should recover both visible edits and deleted payloads from storage',
  ]);
  const hook = renderHook(() => {
    const pending = restartedEnv.apiStore.usePendingOfflineItems({
      selector: (item) => item.name,
    });
    restartedEnv.trackItemUI('pending-items', pending.items.join(', '));
    restartedEnv.trackItemUI(
      'pending-deletes',
      pending.deletedItems.join(', ') || '(none)',
    );
    return pending;
  });
  await act(async () => {
    await Promise.resolve();
  });

  // Local-sync storage can hydrate synchronously, so the first render should
  // already reflect the full pending offline state.
  expect(hook.result.current).toMatchInlineSnapshot(`
    deletedItems: ['users||2']
    items: ['Ada queued']
  `);
  expect(
    restartedEnv.apiStore
      .getOfflineEntities()
      .map((entity) => ({
        entityKey: entity.entityKey,
        pendingMutations: entity.pendingMutations,
        syncState: entity.syncState,
      })),
  ).toMatchInlineSnapshot(`
    - entityKey: '"users||1'
      pendingMutations: 1
      syncState: 'pending'
    - entityKey: '"users||2'
      pendingMutations: 1
      syncState: 'pending'
  `);
  expect(restartedEnv.timelineString).toMatchInlineSnapshot(`
    "
    time | pending-deletes | pending-items |
    0    | -               | -             | -- restart offline and mount only usePendingOfflineItems; it should recover both visible edits and deleted payloads from storage
    .    | users||2        | Ada queued    | [pending-items, pending-deletes, pending-items, pending-deletes] ui-initialized
    "
  `);

  hook.unmount();
});

test('async OPFS idle offline boot hydrates pending offline items from storage without a list query mount', async () => {
  const sessionKey = 'offline-opfs-pending-items-session';
  const storeName = 'offline-opfs-pending-items-store';

  createOpfsPersistentStorageTestStore();

  const firstEnv = createOfflinePendingItemsListQueryEnv({
    adapter: opfsPersistentStorage,
    sessionKey,
    storeName,
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
  });

  // Queue the same visible edit plus delete pair, but persist them through the
  // async OPFS adapter so the restart path has to preload item snapshots.
  act(() => {
    network.goOffline();
  });
  await flushAllTimers();

  await resolveAfterAllTimers(
    firstEnv.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        firstEnv.apiStore.updateItemState('users||1', (item) => ({
          ...item,
          name: 'Ada queued',
        }));
      },
      mutation: async () => {
        await firstEnv.serverTable.delayedSetItem('users||1', {
          id: 1,
          name: 'Ada queued',
        });
        return { name: 'Ada queued' };
      },
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada queued' },
      },
    }),
  );
  await resolveAfterAllTimers(
    firstEnv.apiStore.performMutation('users||2', {
      optimisticUpdate: () => {
        firstEnv.apiStore.deleteItemState('users||2');
      },
      mutation: async () => {
        await firstEnv.serverTable.delayedRemoveItem('users||2');
      },
      offline: { operation: 'deleteUser', input: { itemId: 'users||2' } },
    }),
  );
  await flushAllTimers();

  // Reboot into an idle store so the hook has to restore state from persisted
  // OPFS records instead of from any mounted query.
  __resetSessionOfflineCoordinatorRegistryForTests();

  const restartedEnv = createOfflinePendingItemsListQueryEnv({
    adapter: opfsPersistentStorage,
    sessionKey,
    storeName,
    testScenario: 'idle',
  });

  restartedEnv.addTimelineComments('beforeNextAction', [
    'restart offline with OPFS storage and mount only usePendingOfflineItems; the async preload should recover the same pending state',
  ]);
  const hook = renderHook(() => {
    const pending = restartedEnv.apiStore.usePendingOfflineItems({
      selector: (item) => item.name,
    });
    restartedEnv.trackItemUI(
      'pending-items',
      pending.items.join(', ') || '(none)',
    );
    restartedEnv.trackItemUI(
      'pending-deletes',
      pending.deletedItems.join(', ') || '(none)',
    );
    return pending;
  });

  // Async storage cannot hydrate on the first render, so wait for the preload
  // to materialize the persisted item snapshot into live store state.
  await act(async () => {
    await Promise.resolve();
  });
  await flushAllTimers();
  await act(async () => {
    await Promise.resolve();
  });

  expect(hook.result.current).toMatchInlineSnapshot(`
    deletedItems: ['users||2']
    items: ['Ada queued']
  `);
  expect(restartedEnv.timelineString).toMatchInlineSnapshot(`
    "
    time | pending-deletes | pending-items |
    0    | -               | -             | -- restart offline with OPFS storage and mount only usePendingOfflineItems; the async preload should recover the same pending state
    .    | (none)          | (none)        | [pending-items, pending-deletes] ui-initialized
    9ms  | users||2        | (none)        | [pending-deletes] ui-changed
    15ms | users||2        | Ada queued    | [pending-items] ui-changed
    "
  `);

  hook.unmount();
}, 10_000);

test('the default OPFS offline persistence keeps the raw file paths and JSON payloads transparent', async () => {
  const sessionKey = 'offline-opfs-format-session';
  const storeName = 'offline-opfs-format-doc';
  const mockAdapter = createOpfsPersistentStorageTestStore();
  const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.123456789);

  try {
    // Start fully offline so the OPFS-backed adapter has to persist the same
    // offline queue and session metadata that local-sync stores in localStorage.
    network.setOffline();

    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: opfsPersistentStorage,
        schema: docSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => sessionKey,
            config: { network: network.config },
          }),
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

    await Promise.resolve();

    // Queue one optimistic mutation so the snapshot captures the persisted
    // document, the queue entry, the entity metadata, and the session status.
    await resolveAfterAllTimers(
      env.apiStore.performMutation({
        optimisticUpdate: () => {
          env.apiStore.updateState((draft) => {
            draft.value = 2;
          });
        },
        mutation: async () => {
          await env.serverMock.delayedSetData(2);
          return 2;
        },
        offline: { operation: 'updateValue', input: { value: 2 } },
      }),
    );
    await flushAllTimers();

    expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
      "tsdf (1.21 kb)
      ├ offline-opfs-format-session (1.14 kb)
      │ └ offline-opfs-format-doc (1.09 kb)
      │   ├ d._i.r.json (0.10 kb)
      │   ├ d.e.p.json (0.05 kb)
      │   ├ oe._i.r.json (0.10 kb)
      │   ├ oe.document.p.json (0.20 kb)
      │   ├ oq._i.r.json (0.17 kb)
      │   └ oq.offline-opfs-format-doc%3A1735689600003%3A4fzzzxjy.p.json (0.43 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);
    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.33 kb)
      ├ _am.g (0.05 kb)
      ├ _m.r.s:offline-opfs-format-session._o_.s.m (0.13 kb)
      └ offline-opfs-format-session._o_.s (0.14 kb)"
    `);

    expect(getParsedLocalStorageValue('tsdf.offline-opfs-format-session._o_.s'))
      .toMatchInlineSnapshot(`
        d:
          n: { a: 1, e: 1 }
          u: 1735689600003
      `);
    expect(
      getParsedOpfsFileData(
        'tsdf/offline-opfs-format-session/offline-opfs-format-doc/d._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        - { a: 1735689601041, o: '✅' }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/offline-opfs-format-session/offline-opfs-format-doc/d.e.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d: { value: 2 }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/offline-opfs-format-session/offline-opfs-format-doc/oe._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        document: { a: 1735689600098 }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/offline-opfs-format-session/offline-opfs-format-doc/oe.document.p.json',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689600003
      g: 'd'
      h: 'u'
      k: 'document'
      p: 1
      s: 'p'
      u: 1735689600003
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/offline-opfs-format-session/offline-opfs-format-doc/oq._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        offline-opfs-format-doc:1735689600003:4fzzzxjy: { a: 1735689600044 }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/offline-opfs-format-session/offline-opfs-format-doc/oq.offline-opfs-format-doc%3A1735689600003%3A4fzzzxjy.p.json',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689600003
      d: 'offline-opfs-format-doc:1735689600003:4fzzzxjy'
      e: ['d:document']
      i: { value: 2 }
      o: 'updateValue'
      s: 'p'
      u: 1735689600003
      w: 'd'
    `);
  } finally {
    randomSpy.mockRestore();
  }
}, 10_000);

test('the default OPFS offline persistence rehydrates queued data in a new browser session and replays it once the browser is back online', async () => {
  const sessionKey = 'offline-opfs-restart-session';
  const storeName = 'offline-opfs-restart-doc';

  createOpfsPersistentStorageTestStore();
  network.setOffline();

  const firstEnv = createOfflineDocumentEnv({
    adapter: opfsPersistentStorage,
    sessionKey,
    storeName,
    testScenario: 'loaded',
  });

  await resolveAfterAllTimers(
    firstEnv.apiStore.performMutation({
      optimisticUpdate: () => {
        firstEnv.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: async () => {
        await firstEnv.serverMock.delayedSetData(2);
        return 2;
      },
      offline: { operation: 'updateValue', input: { value: 2 } },
    }),
  );
  await flushAllTimers();

  // Simulate a fresh browser session booting with only persisted storage.
  __resetSessionOfflineCoordinatorRegistryForTests();

  const restartedEnv = createOfflineDocumentEnv({
    adapter: opfsPersistentStorage,
    sessionKey,
    storeName,
    testScenario: 'idle',
  });
  const hook = renderHook(() =>
    restartedEnv.apiStore.useDocument({ returnRefetchingStatus: true }),
  );

  await flushAllTimers();

  expect(hook.result.current).toMatchInlineSnapshot(`
    data: { value: 2 }
    error: null
    isLoading: '❌'
    pendingSync: '✅'
    status: 'success'
  `);
  expect(
    restartedEnv.apiStore
      .getOfflineEntities()
      .map((entity) => ({
        entityKey: entity.entityKey,
        pendingMutations: entity.pendingMutations,
        syncState: entity.syncState,
      })),
  ).toMatchInlineSnapshot(`
    - { entityKey: 'document', pendingMutations: 1, syncState: 'pending' }
  `);

  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(hook.result.current).toMatchInlineSnapshot(`
    data: { value: 2 }
    error: null
    isLoading: '❌'
    pendingSync: '❌'
    status: 'success'
  `);
  expect(restartedEnv.apiStore.getOfflineEntities()).toMatchInlineSnapshot(
    `[]`,
  );

  hook.unmount();
}, 10_000);

test('the default OPFS offline persistence replays queued data when a new browser session boots already online', async () => {
  const sessionKey = 'offline-opfs-online-restart-session';
  const storeName = 'offline-opfs-online-restart-doc';
  const replayedInputs: { value: number }[] = [];

  createOpfsPersistentStorageTestStore();
  network.setOffline();

  const firstEnv = createOfflineDocumentEnv({
    adapter: opfsPersistentStorage,
    sessionKey,
    storeName,
    testScenario: 'loaded',
  });

  await resolveAfterAllTimers(
    firstEnv.apiStore.performMutation({
      optimisticUpdate: () => {
        firstEnv.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: async () => {
        await firstEnv.serverMock.delayedSetData(2);
        return 2;
      },
      offline: { operation: 'updateValue', input: { value: 2 } },
    }),
  );
  await flushAllTimers();

  // Simulate reopening the app after connectivity recovered elsewhere.
  __resetSessionOfflineCoordinatorRegistryForTests();
  act(() => {
    network.goOnline();
  });

  const restartedEnv = createOfflineDocumentEnv({
    adapter: opfsPersistentStorage,
    sessionKey,
    storeName,
    testScenario: 'idle',
    onExecute: (input) => {
      replayedInputs.push(input);
    },
  });
  const hook = renderHook(() =>
    restartedEnv.apiStore.useDocument({ returnRefetchingStatus: true }),
  );

  await flushAllTimers();

  expect(replayedInputs).toMatchInlineSnapshot(`
    - value: 2
  `);
  expect(hook.result.current).toMatchInlineSnapshot(`
    data: { value: 2 }
    error: null
    isLoading: '❌'
    pendingSync: '❌'
    status: 'success'
  `);
  expect(restartedEnv.apiStore.getOfflineEntities()).toMatchInlineSnapshot(
    `[]`,
  );

  hook.unmount();
}, 10_000);

// Logging out via the public clearSessionStorage helper should clear both the
// configured adapter data and the shared offline session snapshot.
test('clearing an OPFS-backed session also clears the shared offline status snapshot', async () => {
  const sessionKey = 'offline-opfs-clear-session';
  const storeName = 'offline-opfs-clear-session-doc';

  // Recreate the real async storage backend and enter offline mode before the
  // store boots so the session persists its offline snapshot through the normal flow.
  createOpfsPersistentStorageTestStore();
  network.setOffline();

  const env = createOfflineDocumentEnv({
    adapter: opfsPersistentStorage,
    sessionKey,
    storeName,
    testScenario: 'loaded',
  });

  // Persist queued work so the session writes its compact offline status snapshot.
  await resolveAfterAllTimers(
    env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: async () => {
        await env.serverMock.delayedSetData(2);
        return 2;
      },
      offline: { operation: 'updateValue', input: { value: 2 } },
    }),
  );
  await flushAllTimers();

  // Sanity-check the persisted session state the app would see on the next boot.
  expect(localStorage.getItem(`tsdf.${sessionKey}._o_.s`)).not.toBeNull();
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'offline-opfs-clear-session'
  `);

  // Clear the session exactly how an app would on logout.
  await resolveAfterAllTimers(
    clearSessionStorage(sessionKey, opfsPersistentStorage),
  );

  // Simulate a fresh app boot that only has persisted state to inspect.
  __resetSessionOfflineCoordinatorRegistryForTests();

  // After logout, the shared offline session should look fully reset as well.
  expect(localStorage.getItem(`tsdf.${sessionKey}._o_.s`)).toBeNull();
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'offline-opfs-clear-session'
  `);
}, 10_000);
