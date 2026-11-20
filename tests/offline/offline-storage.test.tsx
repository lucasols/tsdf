import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { PartialResourcesConfig } from '../../src/listQueryStore/types';
import {
  clearSessionStorage,
  type DocumentOfflineOperationDefinition,
  type ListQueryOfflineOperationDefinition,
} from '../../src/main';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import { createStoreManager } from '../../src/storeManager';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
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
import { resetSessionForTests } from '../utils/resetSessionForTests';
import {
  type CreateListQueryUserOperations,
  deleteItemInputSchema,
  type UpdateValueConflictOperations,
  type UpdateValueOperations,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  collectionCreateInputSchema,
  docConflictSchema,
  docMutationInputSchema,
  docSchema,
  getGlobalOfflineStatusSummary,
  listQueryQueryPayloadSchema,
  summarizeResolution,
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
  inferFields: (item) => Object.keys(item),
};

function createOfflineDocumentEnv({
  adapter,
  sessionKey,
  storeName,
  testScenario,
  onExecute,
  startedLongBeforeTestTime = false,
}: {
  adapter: 'local-sync' | typeof opfsPersistentStorage;
  sessionKey: string;
  storeName: string;
  testScenario: 'idle' | 'loaded';
  onExecute?: (input: { value: number }) => void;
  /** The app ran days before `TEST_INITIAL_TIME`. */
  startedLongBeforeTestTime?: boolean;
}) {
  const envRef: {
    current: ReturnType<
      typeof createDocumentStoreTestEnv<number, UpdateValueOperations>
    > | null;
  } = { current: null };

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: storeName,
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: { network: network.config },
    }),
    testScenario,
    __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__: startedLongBeforeTestTime,
    persistentStorage: {
      adapter,
      schema: docSchema,
      offline: {
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

/**
 * A document store with an `updateValue` operation whose replay of `value: 3`
 * ends in a conflict. In the deploy tests, it is the app after the deploy that
 * added `updateValue`.
 */
function createConflictingDocumentEnv({
  sessionKey,
  storeName,
  onExecute,
  adapter = 'local-sync',
  startedLongBeforeTestTime = false,
}: {
  sessionKey: string;
  storeName: string;
  onExecute?: (input: { value: number }) => void;
  adapter?: 'local-sync' | typeof opfsPersistentStorage;
  /** The app ran days before `TEST_INITIAL_TIME`. */
  startedLongBeforeTestTime?: boolean;
}) {
  const env = createDocumentStoreTestEnv<number, UpdateValueConflictOperations>(
    1,
    {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      testScenario: 'loaded',
      __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__: startedLongBeforeTestTime,
      persistentStorage: {
        adapter,
        schema: docSchema,
        offline: {
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              kind: 'update',
              execute: async ({ input }) => {
                onExecute?.(input);
                await env.serverMock.delayedSetData(input.value);
                return input;
              },
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: ({ input }) =>
                  input.value === 3 ? { reason: 'server-changed' } : false,
              },
            },
          },
        },
      },
    },
  );

  return env;
}

type OlderDeployOperations = {
  legacyUpdateValue: DocumentOfflineOperationDefinition<
    { value: number },
    { input: { value: number } }
  >;
};

/**
 * The same store in a tab still running the deploy from before `updateValue`
 * existed: it only knows `legacyUpdateValue`.
 */
function createOlderDeployDocumentEnv({
  sessionKey,
  storeName,
}: {
  sessionKey: string;
  storeName: string;
}) {
  return createDocumentStoreTestEnv<number, OlderDeployOperations>(1, {
    id: storeName,
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: { network: network.config },
    }),
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          legacyUpdateValue: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            execute: ({ input }) => Promise.resolve(input),
          },
        },
      },
    },
  });
}

function createDeployStoreManager(
  sessionKey: string,
  onPersistentStorageError?: (error: unknown) => void,
) {
  return createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: { network: network.config },
    onPersistentStorageError,
  });
}

type DocumentValueOperation = DocumentOfflineOperationDefinition<
  { value: number },
  { input: { value: number } }
>;

/**
 * A document store of a deploy that defines `operationNames`. Each replay is
 * logged in `sent` as `label.operation(value)`.
 */
function createDeployDocumentEnv({
  storeManager,
  storeName,
  label,
  operationNames,
  removedOperations,
  sent,
}: {
  storeManager: ReturnType<typeof createDeployStoreManager>;
  storeName: string;
  label: string;
  operationNames: readonly string[];
  removedOperations?: readonly string[];
  sent: string[];
}) {
  const operations: Record<string, DocumentValueOperation> = {};
  for (const operationName of operationNames) {
    operations[operationName] = {
      inputSchema: docMutationInputSchema,
      kind: 'update',
      execute: ({ input }) => {
        sent.push(`${label}.${operationName}(${input.value})`);
        return Promise.resolve(input);
      },
    };
  }

  return createDocumentStoreTestEnv<
    number,
    Record<string, DocumentValueOperation>
  >(1, {
    id: storeName,
    storeManager,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations, removedOperations },
    },
  });
}

function queueOfflineValueEdit(
  env: ReturnType<typeof createDeployDocumentEnv>,
  operation: string,
  value: number,
) {
  return resolveAfterAllTimers(
    env.apiStore.performMutation({
      mutation: () => Promise.resolve(value),
      offline: { operation, input: { value } },
    }),
  );
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
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: { network: network.config },
    }),
    testScenario,
    partialResources: partialResourcesConfig,
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
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: { network: network.config },
    }),
    testScenario,
    persistentStorage: {
      adapter,
      schema: userRowSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: listQueryQueryPayloadSchema,
      offline: {
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
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  network = createOfflineNetworkMock();
  network.install();
  resetSessionForTests({ clearStorage: true });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  resetSessionForTests({ clearStorage: true });
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
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
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
      "tsdf (1.48 kb)
      ├ _m (0.67 kb)
      │ ├ g (0.04 kb)
      │ └ r (0.62 kb)
      │   ├ n:offline-sync-format-session.offline-sync-format-doc (0.37 kb)
      │   │ ├ oe.m (0.09 kb)
      │   │ └ oq.m (0.17 kb)
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
        document: { a: 1735689600000, z: 82 }
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf._m.r.n:offline-sync-format-session.offline-sync-format-doc.oq.m',
      ),
    ).toMatchInlineSnapshot(`
      e:
        offline-sync-format-doc:1735689600000:4fzzzxjy: { a: 1735689600000, z: 159 }
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
  resetSessionForTests();

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
  resetSessionForTests();
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

test('local-sync offline edits are still sent when the app is reopened more than a week later', async () => {
  const sessionKey = 'offline-sync-week-later-session';
  const storeName = 'offline-sync-week-later-doc';
  const replayedInputs: { value: number }[] = [];

  // Eight days ago, longer than the cache max age, the user edited offline
  // and closed the app before reconnecting.
  vi.setSystemTime(TEST_INITIAL_TIME - 8 * 24 * 60 * 60 * 1000);
  network.setOffline();
  const firstEnv = createOfflineDocumentEnv({
    adapter: 'local-sync',
    sessionKey,
    storeName,
    testScenario: 'loaded',
    startedLongBeforeTestTime: true,
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

  // Today the user reopens the app online.
  resetSessionForTests();
  vi.setSystemTime(TEST_INITIAL_TIME);
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
  const hook = renderHook(() => restartedEnv.apiStore.useDocument());
  await flushAllTimers();

  // The queued edit is not expired like cached data: it is still sent.
  expect(replayedInputs).toMatchInlineSnapshot(`
    - value: 2
  `);
  expect(restartedEnv.apiStore.getOfflineEntities()).toMatchInlineSnapshot(
    `[]`,
  );

  hook.unmount();
});

test('opfs conflicts left unresolved for more than two weeks can still be resolved', async () => {
  createOpfsPersistentStorageTestStore();
  const sessionKey = 'offline-opfs-old-conflict-session';
  const storeName = 'offline-opfs-old-conflict-doc';

  // Fifteen days ago, longer than the async cache max age, an offline edit
  // ended in a conflict when the connection came back, and the user left it
  // unresolved.
  vi.setSystemTime(TEST_INITIAL_TIME - 15 * 24 * 60 * 60 * 1000);
  network.setOffline();
  const firstEnv = createConflictingDocumentEnv({
    sessionKey,
    storeName,
    adapter: opfsPersistentStorage,
    startedLongBeforeTestTime: true,
  });
  await resolveAfterAllTimers(
    firstEnv.apiStore.performMutation({
      optimisticUpdate: () => {
        firstEnv.apiStore.updateState((draft) => {
          draft.value = 3;
        });
      },
      mutation: async () => {
        await firstEnv.serverMock.delayedSetData(3);
        return 3;
      },
      offline: { operation: 'updateValue', input: { value: 3 } },
    }),
  );
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();
  expect(firstEnv.apiStore.getOfflineResolutions()).toHaveLength(1);

  // Today the user opens the app online, which runs the storage cleanup.
  resetSessionForTests();
  vi.setSystemTime(TEST_INITIAL_TIME);
  const restartedEnv = createConflictingDocumentEnv({
    sessionKey,
    storeName,
    adapter: opfsPersistentStorage,
  });
  const restartedHook = renderHook(() => restartedEnv.apiStore.useDocument());
  await flushAllTimers();
  restartedHook.unmount();

  // The conflict is unsent work, not cached data: it doesn't expire, so it is
  // still there when the app is opened again.
  resetSessionForTests();
  const reopenedEnv = createConflictingDocumentEnv({
    sessionKey,
    storeName,
    adapter: opfsPersistentStorage,
  });
  const reopenedHook = renderHook(() => reopenedEnv.apiStore.useDocument());
  await flushAllTimers();

  const [resolution] = reopenedEnv.apiStore.getOfflineResolutions();
  if (!resolution) throw new Error('Expected the conflict to be kept');
  expect(summarizeResolution(resolution)).toMatchInlineSnapshot(`
    input: 'value: 3'
    kind: 'conflict'
    on: 'document:document'
    op: 'updateValue'
    reason: 'server-changed'
  `);

  reopenedHook.unmount();
});

test('an older deploy keeps edits queued for an operation only a newer deploy knows, and the newer deploy sends them', async () => {
  const sessionKey = 'offline-unknown-operation-entry-session';
  const storeName = 'offline-unknown-operation-entry-doc';
  const sentByNewerDeploy: { value: number }[] = [];

  // The user edits offline in the newer deploy.
  network.setOffline();
  const newerEnv = createConflictingDocumentEnv({ sessionKey, storeName });
  await resolveAfterAllTimers(
    newerEnv.apiStore.performMutation({
      optimisticUpdate: () => {
        newerEnv.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: async () => {
        await newerEnv.serverMock.delayedSetData(2);
        return 2;
      },
      offline: { operation: 'updateValue', input: { value: 2 } },
    }),
  );
  await flushAllTimers();

  // The connection comes back while only a tab of the older deploy is open
  // (e.g. a tab that was not reloaded after the deploy).
  resetSessionForTests();
  act(() => {
    network.goOnline();
  });
  const olderEnv = createOlderDeployDocumentEnv({ sessionKey, storeName });
  const olderHook = renderHook(() => olderEnv.apiStore.useDocument());
  await flushAllTimers();

  // The older deploy can't send an operation it doesn't define, so it doesn't
  // list it either. Before, its replay deleted the edit from storage.
  expect(olderEnv.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  olderHook.unmount();

  // The user reloads into the newer deploy: the edit is still queued and is
  // sent once.
  resetSessionForTests();
  const reloadedEnv = createConflictingDocumentEnv({
    sessionKey,
    storeName,
    onExecute: (input) => {
      sentByNewerDeploy.push(input);
    },
  });
  const reloadedHook = renderHook(() => reloadedEnv.apiStore.useDocument());
  await flushAllTimers();

  expect(sentByNewerDeploy).toMatchInlineSnapshot(`
    - value: 2
  `);
  expect(reloadedEnv.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);

  reloadedHook.unmount();
});

test('an older deploy keeps conflicts of an operation only a newer deploy knows', async () => {
  const sessionKey = 'offline-unknown-operation-resolution-session';
  const storeName = 'offline-unknown-operation-resolution-doc';

  // In the newer deploy, an offline edit ends in a conflict when it is sent.
  network.setOffline();
  const newerEnv = createConflictingDocumentEnv({ sessionKey, storeName });
  await resolveAfterAllTimers(
    newerEnv.apiStore.performMutation({
      optimisticUpdate: () => {
        newerEnv.apiStore.updateState((draft) => {
          draft.value = 3;
        });
      },
      mutation: async () => {
        await newerEnv.serverMock.delayedSetData(3);
        return 3;
      },
      offline: { operation: 'updateValue', input: { value: 3 } },
    }),
  );
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();
  expect(newerEnv.apiStore.getOfflineResolutions()).toHaveLength(1);

  // A tab of the older deploy opens the store. It can't resolve a conflict of
  // an operation it doesn't define, so it doesn't list it. Before, it deleted
  // the conflict from storage while loading it.
  resetSessionForTests();
  const olderEnv = createOlderDeployDocumentEnv({ sessionKey, storeName });
  const olderHook = renderHook(() => olderEnv.apiStore.useDocument());
  await flushAllTimers();
  expect(olderEnv.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  olderHook.unmount();

  // Back in the newer deploy, the user can still resolve the conflict.
  resetSessionForTests();
  const reloadedEnv = createConflictingDocumentEnv({ sessionKey, storeName });
  const reloadedHook = renderHook(() => reloadedEnv.apiStore.useDocument());
  await flushAllTimers();

  const [resolution] = reloadedEnv.apiStore.getOfflineResolutions();
  if (!resolution) throw new Error('Expected the conflict to still be queued');
  expect(summarizeResolution(resolution)).toMatchInlineSnapshot(`
    input: 'value: 3'
    kind: 'conflict'
    on: 'document:document'
    op: 'updateValue'
    reason: 'server-changed'
  `);

  reloadedHook.unmount();
});

test('an older deploy pauses sync behind edits only a newer deploy can send, so the latest edit is the one kept', async () => {
  const sessionKey = 'offline-unknown-operation-order-session';
  const docStoreName = 'offline-unknown-operation-order-doc';
  const otherStoreName = 'offline-unknown-operation-order-other';
  const sent: string[] = [];

  // In the newer deploy, which added `updateValue`, the user edits a document
  // offline twice: first with the new operation, then with one both deploys
  // know. Then they edit another store, also with an operation both know.
  network.setOffline();
  const newerStoreManager = createDeployStoreManager(sessionKey);
  const newerDoc = createDeployDocumentEnv({
    storeManager: newerStoreManager,
    storeName: docStoreName,
    label: 'doc',
    operationNames: ['updateValue', 'legacyUpdateValue'],
    sent,
  });
  const newerOther = createDeployDocumentEnv({
    storeManager: newerStoreManager,
    storeName: otherStoreName,
    label: 'other',
    operationNames: ['legacyUpdateValue'],
    sent,
  });
  await queueOfflineValueEdit(newerDoc, 'updateValue', 5);
  await queueOfflineValueEdit(newerDoc, 'legacyUpdateValue', 7);
  await queueOfflineValueEdit(newerOther, 'legacyUpdateValue', 1);
  await flushAllTimers();

  // The connection comes back while only a tab of the older deploy, which
  // doesn't define `updateValue`, is open.
  resetSessionForTests();
  act(() => {
    network.goOnline();
  });
  const reportedErrors: string[] = [];
  const olderStoreManager = createDeployStoreManager(sessionKey, (error) => {
    reportedErrors.push(error instanceof Error ? error.message : 'unknown');
  });
  const olderDoc = createDeployDocumentEnv({
    storeManager: olderStoreManager,
    storeName: docStoreName,
    label: 'doc',
    operationNames: ['legacyUpdateValue'],
    sent,
  });
  const olderOther = createDeployDocumentEnv({
    storeManager: olderStoreManager,
    storeName: otherStoreName,
    label: 'other',
    operationNames: ['legacyUpdateValue'],
    sent,
  });
  const olderDocHook = renderHook(() => olderDoc.apiStore.useDocument());
  const olderOtherHook = renderHook(() => olderOther.apiStore.useDocument());
  await flushAllTimers();

  // Sending the edits it knows would put `7` on the server before `5`, and
  // the newer deploy would later overwrite the user's latest edit with `5`.
  // The document store waits instead, and so does the later edit of the
  // other store, to keep the order the user made them in.
  expect(sent).toMatchInlineSnapshot(`[]`);
  // The app is told why the store waits, in case the operation was removed
  // for good (e.g. a rolled back deploy) and must be listed in
  // `removedOperations`.
  expect(reportedErrors).toMatchInlineSnapshot(
    `- '[tsdf] Store "offline-unknown-operation-order-doc" has unsent offline work of operations this deploy does not define (updateValue). It is kept for a deploy that defines them, and the store pauses sending its offline work until then. If they were removed for good, list them in removedOperations.'`,
  );
  olderDocHook.unmount();
  olderOtherHook.unmount();

  // The user reloads into the newer deploy: every edit is sent in order.
  resetSessionForTests();
  const reloadedStoreManager = createDeployStoreManager(sessionKey);
  const reloadedDoc = createDeployDocumentEnv({
    storeManager: reloadedStoreManager,
    storeName: docStoreName,
    label: 'doc',
    operationNames: ['updateValue', 'legacyUpdateValue'],
    sent,
  });
  const reloadedOther = createDeployDocumentEnv({
    storeManager: reloadedStoreManager,
    storeName: otherStoreName,
    label: 'other',
    operationNames: ['legacyUpdateValue'],
    sent,
  });
  const reloadedDocHook = renderHook(() => reloadedDoc.apiStore.useDocument());
  const reloadedOtherHook = renderHook(() =>
    reloadedOther.apiStore.useDocument(),
  );
  await flushAllTimers();

  expect(sent).toMatchInlineSnapshot(
    `['doc.updateValue(5)', 'doc.legacyUpdateValue(7)', 'other.legacyUpdateValue(1)']`,
  );

  reloadedDocHook.unmount();
  reloadedOtherHook.unmount();
});

test('an online edit in an older deploy waits behind an earlier edit only a newer deploy can send', async () => {
  const sessionKey = 'offline-unknown-operation-online-edit-session';
  const storeName = 'offline-unknown-operation-online-edit-doc';
  const sent: string[] = [];

  // In the newer deploy, which added `updateValue`, the user edits the
  // document offline.
  network.setOffline();
  const newerEnv = createDeployDocumentEnv({
    storeManager: createDeployStoreManager(sessionKey),
    storeName,
    label: 'newer',
    operationNames: ['updateValue', 'legacyUpdateValue'],
    sent,
  });
  await queueOfflineValueEdit(newerEnv, 'updateValue', 5);
  await flushAllTimers();

  // Back online, in a tab of the older deploy, the user edits it again. Sent
  // right away, this later edit would reach the server first and the newer
  // deploy would then overwrite it with `5`: it waits behind it instead.
  resetSessionForTests();
  act(() => {
    network.goOnline();
  });
  const olderEnv = createDeployDocumentEnv({
    storeManager: createDeployStoreManager(sessionKey),
    storeName,
    label: 'older',
    operationNames: ['legacyUpdateValue'],
    sent,
  });
  const olderHook = renderHook(() => olderEnv.apiStore.useDocument());
  await flushAllTimers();
  await queueOfflineValueEdit(olderEnv, 'legacyUpdateValue', 9);
  await flushAllTimers();
  olderHook.unmount();

  // The user reloads into the newer deploy: both edits are sent in the order
  // they were made, so the server ends with the latest one. Had the older
  // deploy sent `9` right away, only `5` would be sent here.
  resetSessionForTests();
  const reloadedEnv = createDeployDocumentEnv({
    storeManager: createDeployStoreManager(sessionKey),
    storeName,
    label: 'reloaded',
    operationNames: ['updateValue', 'legacyUpdateValue'],
    sent,
  });
  const reloadedHook = renderHook(() => reloadedEnv.apiStore.useDocument());
  await flushAllTimers();
  expect(sent).toMatchInlineSnapshot(
    `['reloaded.updateValue(5)', 'reloaded.legacyUpdateValue(9)']`,
  );

  reloadedHook.unmount();
});

test('queued edits of an operation listed in removedOperations are deleted and no longer hold back sync', async () => {
  const sessionKey = 'offline-removed-operation-session';
  const storeName = 'offline-removed-operation-doc';
  const sent: string[] = [];
  const reportedErrors: string[] = [];

  // An older deploy still has `oldUpdateValue`. The user edits offline with
  // it, then with `updateValue`.
  network.setOffline();
  const olderEnv = createDeployDocumentEnv({
    storeManager: createDeployStoreManager(sessionKey),
    storeName,
    label: 'doc',
    operationNames: ['oldUpdateValue', 'updateValue'],
    sent,
  });
  await queueOfflineValueEdit(olderEnv, 'oldUpdateValue', 2);
  await queueOfflineValueEdit(olderEnv, 'updateValue', 3);
  await flushAllTimers();

  // The next deploy deletes `oldUpdateValue` for good and lists it in
  // `removedOperations`. The user opens it online.
  resetSessionForTests();
  act(() => {
    network.goOnline();
  });
  const newerEnv = createDeployDocumentEnv({
    storeManager: createDeployStoreManager(sessionKey, (error) => {
      reportedErrors.push(error instanceof Error ? error.message : 'unknown');
    }),
    storeName,
    label: 'doc',
    operationNames: ['updateValue'],
    removedOperations: ['oldUpdateValue'],
    sent,
  });
  const newerHook = renderHook(() => newerEnv.apiStore.useDocument());
  await flushAllTimers();

  // The edit of the removed operation can't be sent by any deploy anymore:
  // it is dropped and reported, and the edit after it is sent.
  expect(sent).toMatchInlineSnapshot(`['doc.updateValue(3)']`);
  expect(reportedErrors).toMatchInlineSnapshot(
    `- '[tsdf] Store "offline-removed-operation-doc" still had 1 unsent offline record(s) (queued mutations or pending resolutions) of operations listed in its removedOperations, or of entities they created. They are deleted: no deploy can replay them anymore.'`,
  );
  newerHook.unmount();

  // It was deleted from storage, so it is not reported again.
  resetSessionForTests();
  reportedErrors.length = 0;
  const reopenedEnv = createDeployDocumentEnv({
    storeManager: createDeployStoreManager(sessionKey, (error) => {
      reportedErrors.push(error instanceof Error ? error.message : 'unknown');
    }),
    storeName,
    label: 'doc',
    operationNames: ['updateValue'],
    removedOperations: ['oldUpdateValue'],
    sent,
  });
  const reopenedHook = renderHook(() => reopenedEnv.apiStore.useDocument());
  await flushAllTimers();
  expect(reportedErrors).toMatchInlineSnapshot(`[]`);

  reopenedHook.unmount();
});

/**
 * The persistent storage config of a users list query store of a deploy that
 * defines `operations`.
 */
function usersDeployPersistentStorage<TOperations>(
  operations: TOperations,
  removedOperations?: readonly string[],
) {
  return {
    adapter: 'local-sync' as const,
    schema: userRowSchema,
    itemPayloadSchema: rc_string,
    queryPayloadSchema: listQueryQueryPayloadSchema,
    offline: { operations, removedOperations },
  };
}

type PatchUserNameOperation = ListQueryOfflineOperationDefinition<
  OfflineStorageUserRow,
  ListQueryParams,
  string,
  { itemId: string; name: string },
  unknown
>;

function createPatchUserNameOperation(sent: string[]): PatchUserNameOperation {
  return {
    inputSchema: userPatchSchema,
    kind: 'update',
    getEntityRefs: ({ input }) => [input.itemId],
    execute: ({ input }) => {
      sent.push(`patchUserName(${input.itemId}, ${input.name})`);
      return Promise.resolve({ name: input.name });
    },
    // Only what is sent matters here.
    onSuccessExecute: () => {},
  };
}

function createCreateUserOperation(
  sent: string[],
): CreateListQueryUserOperations['createUser'] {
  return {
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
    execute: ({ input }) => {
      sent.push(`createUser(${input.name})`);
      return Promise.resolve({ id: 3, name: input.name });
    },
  };
}

type PatchUserNameOperations = { patchUserName: PatchUserNameOperation };

test('removing a create operation also deletes the queued edits of the items it would have created', async () => {
  const sessionKey = 'offline-removed-create-operation-session';
  const storeName = 'offline-removed-create-operation-users';
  const sent: string[] = [];
  const reportedErrors: string[] = [];

  // In a deploy that still has `createUser`, the user creates a user offline
  // and renames it. They also rename a user that already exists.
  network.setOffline();
  const createUser = createCreateUserOperation(sent);
  const olderEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    CreateListQueryUserOperations & PatchUserNameOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage({
      createUser,
      patchUserName: createPatchUserNameOperation(sent),
    }),
  });
  await resolveAfterAllTimers(
    olderEnv.apiStore.performMutation(null, {
      mutation: () => Promise.resolve({ id: 3, name: 'Linus' }),
      offline: { operation: 'createUser', input: { name: 'Linus' } },
    }),
  );
  await resolveAfterAllTimers(
    olderEnv.apiStore.performMutation('temp:Linus', {
      mutation: () => Promise.resolve({ name: 'Linus T.' }),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'temp:Linus', name: 'Linus T.' },
      },
    }),
  );
  await resolveAfterAllTimers(
    olderEnv.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve({ name: 'Ada L.' }),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada L.' },
      },
    }),
  );
  await flushAllTimers();

  // The next deploy deletes `createUser` for good and lists it in
  // `removedOperations`. The user opens it online.
  resetSessionForTests();
  act(() => {
    network.goOnline();
  });
  const newerEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    PatchUserNameOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey, (error) => {
      reportedErrors.push(error instanceof Error ? error.message : 'unknown');
    }),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage(
      { patchUserName: createPatchUserNameOperation(sent) },
      ['createUser'],
    ),
  });
  const newerHook = renderHook(() =>
    newerEnv.apiStore.useListQuery(offlineStorageUsersQuery),
  );
  await flushAllTimers();

  // The created user never reaches the server, so its rename is deleted with
  // it instead of being sent for an item the server doesn't have. The rename
  // of the existing user is still sent.
  expect(sent).toMatchInlineSnapshot(`['patchUserName(users||1, Ada L.)']`);
  expect(reportedErrors).toMatchInlineSnapshot(
    `- '[tsdf] Store "offline-removed-create-operation-users" still had 2 unsent offline record(s) (queued mutations or pending resolutions) of operations listed in its removedOperations, or of entities they created. They are deleted: no deploy can replay them anymore.'`,
  );
  // The optimistic row of the user that will never be created is removed
  // too, instead of staying as a normal row the user could keep editing
  expect(newerEnv.apiStore.getItemState('temp:Linus')).toBeNull();

  newerHook.unmount();
});

test('removing a create operation also deletes the queued edits of its items that the deploy does not define', async () => {
  const sessionKey = 'offline-removed-create-unknown-edit-session';
  const storeName = 'offline-removed-create-unknown-edit-users';
  const sent: string[] = [];
  const reportedErrors: string[] = [];

  // In a deploy with `createUser` and `patchUserName`, the user creates a user
  // offline and renames it.
  network.setOffline();
  const olderEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    CreateListQueryUserOperations & PatchUserNameOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage({
      createUser: createCreateUserOperation(sent),
      patchUserName: createPatchUserNameOperation(sent),
    }),
  });
  await resolveAfterAllTimers(
    olderEnv.apiStore.performMutation(null, {
      mutation: () => Promise.resolve({ id: 3, name: 'Linus' }),
      offline: { operation: 'createUser', input: { name: 'Linus' } },
    }),
  );
  await resolveAfterAllTimers(
    olderEnv.apiStore.performMutation('temp:Linus', {
      mutation: () => Promise.resolve({ name: 'Linus T.' }),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'temp:Linus', name: 'Linus T.' },
      },
    }),
  );
  await flushAllTimers();

  // The next deploy deletes `createUser` for good and, for now, has no
  // `patchUserName` either (it only renames through `renameUser`). The user
  // opens it online.
  resetSessionForTests();
  act(() => {
    network.goOnline();
  });
  const middleEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    { renameUser: PatchUserNameOperation }
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey, (error) => {
      reportedErrors.push(error instanceof Error ? error.message : 'unknown');
    }),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage(
      { renameUser: createPatchUserNameOperation(sent) },
      ['createUser'],
    ),
  });
  const middleHook = renderHook(() =>
    middleEnv.apiStore.useListQuery(offlineStorageUsersQuery),
  );
  await flushAllTimers();

  // The rename of the user that will never exist is deleted with its creation,
  // although this deploy can't read it: kept, it would pause the store's sync
  // and later be sent for an item the server doesn't have
  expect(reportedErrors).toMatchInlineSnapshot(
    `- '[tsdf] Store "offline-removed-create-unknown-edit-users" still had 2 unsent offline record(s) (queued mutations or pending resolutions) of operations listed in its removedOperations, or of entities they created. They are deleted: no deploy can replay them anymore.'`,
  );
  middleHook.unmount();

  // A later deploy brings `patchUserName` back. Nothing is left to send.
  resetSessionForTests();
  const laterEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    PatchUserNameOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage(
      { patchUserName: createPatchUserNameOperation(sent) },
      ['createUser'],
    ),
  });
  const laterHook = renderHook(() =>
    laterEnv.apiStore.useListQuery(offlineStorageUsersQuery),
  );
  await flushAllTimers();

  expect(sent).toMatchInlineSnapshot(`[]`);

  laterHook.unmount();
});

type InviteUserOperation = ListQueryOfflineOperationDefinition<
  OfflineStorageUserRow,
  ListQueryParams,
  string,
  { name: string; invitedBy: string },
  unknown,
  OfflineStorageUserRow
>;

test('removing a create operation also deletes the creations that only depend on its items through dependsOn', async () => {
  const sessionKey = 'offline-removed-create-unknown-dependent-session';
  const storeName = 'offline-removed-create-unknown-dependent-users';
  const sent: string[] = [];
  const reportedErrors: string[] = [];

  // `inviteUser` creates a new user invited by another one. It only refers to
  // the inviter through `dependsOn`, not through its entity refs.
  const inviteUser: InviteUserOperation = {
    inputSchema: rc_object({ name: rc_string, invitedBy: rc_string }),
    kind: 'create',
    getEntityRefs: ({ input }) => [`temp:${input.name}`],
    dependsOn: ({ input }) => [input.invitedBy],
    tempEntity: {
      buildPendingEntity: (input) => ({ id: -2, name: input.name }),
      reconcileServerEntity: (result) => ({
        finalPayload: `users||${result.id}`,
        finalData: result,
      }),
    },
    execute: ({ input }) => {
      sent.push(`inviteUser(${input.name}, ${input.invitedBy})`);
      return Promise.resolve({ id: 4, name: input.name });
    },
  };

  // In a deploy with `createUser` and `inviteUser`, the user creates Linus
  // offline, then invites Grace on Linus' behalf.
  network.setOffline();
  const olderEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    CreateListQueryUserOperations & { inviteUser: InviteUserOperation }
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage({
      createUser: createCreateUserOperation(sent),
      inviteUser,
    }),
  });
  await resolveAfterAllTimers(
    olderEnv.apiStore.performMutation(null, {
      mutation: () => Promise.resolve({ id: 3, name: 'Linus' }),
      offline: { operation: 'createUser', input: { name: 'Linus' } },
    }),
  );
  await resolveAfterAllTimers(
    olderEnv.apiStore.performMutation(null, {
      mutation: () => Promise.resolve({ id: 4, name: 'Grace' }),
      offline: {
        operation: 'inviteUser',
        input: { name: 'Grace', invitedBy: 'temp:Linus' },
      },
    }),
  );
  await flushAllTimers();

  // The next deploy deletes `createUser` for good and doesn't define
  // `inviteUser` yet. The user opens it online.
  resetSessionForTests();
  act(() => {
    network.goOnline();
  });
  const middleEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    PatchUserNameOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey, (error) => {
      reportedErrors.push(error instanceof Error ? error.message : 'unknown');
    }),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage(
      { patchUserName: createPatchUserNameOperation(sent) },
      ['createUser'],
    ),
  });
  const middleHook = renderHook(() =>
    middleEnv.apiStore.useListQuery(offlineStorageUsersQuery),
  );
  await flushAllTimers();

  // Grace's invitation needs Linus, who will never exist. This deploy can't
  // run `inviteUser.dependsOn`, but the invitation's input holds Linus' temp
  // id, so it is deleted with his creation instead of pausing the sync
  expect(reportedErrors).toMatchInlineSnapshot(
    `- '[tsdf] Store "offline-removed-create-unknown-dependent-users" still had 2 unsent offline record(s) (queued mutations or pending resolutions) of operations listed in its removedOperations, or of entities they created. They are deleted: no deploy can replay them anymore.'`,
  );
  middleHook.unmount();

  // A later deploy brings `inviteUser` back. Nothing is left to send for an
  // inviter the server doesn't have.
  resetSessionForTests();
  const laterEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    { inviteUser: InviteUserOperation }
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage({ inviteUser }, [
      'createUser',
    ]),
  });
  const laterHook = renderHook(() =>
    laterEnv.apiStore.useListQuery(offlineStorageUsersQuery),
  );
  await flushAllTimers();

  expect(sent).toMatchInlineSnapshot(`[]`);

  laterHook.unmount();
});

type DeleteUserOperations = {
  deleteUser: ListQueryOfflineOperationDefinition<
    OfflineStorageUserRow,
    ListQueryParams,
    string,
    { itemId: string },
    unknown
  >;
};

test('deleting an unsent item in an older deploy does not drop its creation while a newer deploy still has edits of it', async () => {
  const sessionKey = 'offline-older-delete-unsent-item-session';
  const storeName = 'offline-older-delete-unsent-item-users';
  const sent: string[] = [];
  const deleteUser: DeleteUserOperations['deleteUser'] = {
    inputSchema: deleteItemInputSchema,
    kind: 'delete',
    getEntityRefs: ({ input }) => [input.itemId],
    // Deleting an item that never reached the server drops its creation
    // and the delete itself
    supersedes: {
      scope: 'same-entity',
      dropSelfIfTempLifecycleCancelled: true,
    },
    execute: ({ input }) => {
      sent.push(`deleteUser(${input.itemId})`);
      return Promise.resolve(undefined);
    },
    // Only what is sent matters here.
    onSuccessExecute: () => {},
  };

  // In the newer deploy, the user creates a user offline and renames it with
  // `patchUserName`, an operation the older deploy doesn't have
  network.setOffline();
  const newerEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    CreateListQueryUserOperations &
      PatchUserNameOperations &
      DeleteUserOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage({
      createUser: createCreateUserOperation(sent),
      patchUserName: createPatchUserNameOperation(sent),
      deleteUser,
    }),
  });
  await resolveAfterAllTimers(
    newerEnv.apiStore.performMutation(null, {
      mutation: () => Promise.resolve({ id: 3, name: 'Linus' }),
      offline: { operation: 'createUser', input: { name: 'Linus' } },
    }),
  );
  await resolveAfterAllTimers(
    newerEnv.apiStore.performMutation('temp:Linus', {
      mutation: () => Promise.resolve({ name: 'Linus T.' }),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'temp:Linus', name: 'Linus T.' },
      },
    }),
  );
  await flushAllTimers();

  // Still offline, the user opens the older deploy and deletes that user
  resetSessionForTests();
  const olderEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    CreateListQueryUserOperations & DeleteUserOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage({
      createUser: createCreateUserOperation(sent),
      deleteUser,
    }),
  });
  const olderHook = renderHook(() =>
    olderEnv.apiStore.useListQuery(offlineStorageUsersQuery),
  );
  await flushAllTimers();
  await resolveAfterAllTimers(
    olderEnv.apiStore.performMutation('temp:Linus', {
      mutation: () => Promise.resolve(undefined),
      offline: { operation: 'deleteUser', input: { itemId: 'temp:Linus' } },
    }),
  );
  await flushAllTimers();
  olderHook.unmount();

  // Back online in the newer deploy, the creation, the rename and the delete
  // are sent in the order the user made them. Dropping the creation and the
  // delete would have left the rename to be sent for an item the server never
  // had.
  resetSessionForTests();
  act(() => {
    network.goOnline();
  });
  const reloadedEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    CreateListQueryUserOperations &
      PatchUserNameOperations &
      DeleteUserOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage({
      createUser: createCreateUserOperation(sent),
      patchUserName: createPatchUserNameOperation(sent),
      deleteUser,
    }),
  });
  const reloadedHook = renderHook(() =>
    reloadedEnv.apiStore.useListQuery(offlineStorageUsersQuery),
  );
  await flushAllTimers();

  expect(sent).toMatchInlineSnapshot(`
    - 'createUser(Linus)'
    - 'patchUserName(users||3, Linus T.)'
    - 'deleteUser(users||3)'
  `);

  reloadedHook.unmount();
});

test('local-sync offline edits of list-query items are persisted without storage errors', async () => {
  const sessionKey = 'offline-entity-payload-session';
  const storeName = 'offline-entity-payload-users';
  const sent: string[] = [];
  const reportedErrors: string[] = [];

  // The user renames an existing user while offline. The store keeps the
  // edited item's payload with the offline work it saves for that item.
  network.setOffline();
  const env = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    PatchUserNameOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey, (error) => {
      reportedErrors.push(error instanceof Error ? error.message : 'unknown');
    }),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage({
      patchUserName: createPatchUserNameOperation(sent),
    }),
  });
  await resolveAfterAllTimers(
    env.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve({ name: 'Ada L.' }),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada L.' },
      },
    }),
  );
  await flushAllTimers();

  // Saving the offline state of an item with a payload must not fail: the
  // app's storage error handler would otherwise report it on every offline
  // edit of a list-query or collection item.
  expect(reportedErrors).toMatchInlineSnapshot(`[]`);
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
    await firstEnv.apiStore.performMutation('temp:Linus offline', {
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
    13.1s | -- go offline and queue a temp create; the optimistic row has data but no loadedFields metadata
    .     | offline:createUser queued
    "
  `);

  // Reboot the app while the temp row only exists through persisted fallback
  // state plus offline entity metadata.
  resetSessionForTests();

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
  resetSessionForTests();

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
  resetSessionForTests();

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
    12ms | users||2        | (none)        | [pending-deletes] ui-changed
    17ms | users||2        | Ada queued    | [pending-items] ui-changed
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
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      testScenario: 'loaded',
      persistentStorage: {
        adapter: opfsPersistentStorage,
        schema: docSchema,
        offline: {
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
      "tsdf (1.23 kb)
      ├ offline-opfs-format-session (1.16 kb)
      │ └ offline-opfs-format-doc (1.11 kb)
      │   ├ d._i.r.json (0.10 kb)
      │   ├ d.e.p.json (0.04 kb)
      │   ├ oe._i.r.json (0.11 kb)
      │   ├ oe.document.p.json (0.20 kb)
      │   ├ oq._i.r.json (0.19 kb)
      │   └ oq.offline-opfs-format-doc%3A1735689600003%3A4fzzzxjy.p.json (0.43 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);
    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.38 kb)
      ├ _am.g (0.05 kb)
      ├ _m (0.18 kb)
      │ ├ g (0.04 kb)
      │ └ r.s:offline-opfs-format-session._o_.s.m (0.13 kb)
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
    ).toMatchInlineSnapshot(`value: 2`);
    expect(
      getParsedOpfsFileData(
        'tsdf/offline-opfs-format-session/offline-opfs-format-doc/oe._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        document: { a: 1735689600098, z: 101 }
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
        offline-opfs-format-doc:1735689600003:4fzzzxjy: { a: 1735689600044, z: 178 }
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
  resetSessionForTests();

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
  resetSessionForTests();
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
  resetSessionForTests();

  // After logout, the shared offline session should look fully reset as well.
  expect(localStorage.getItem(`tsdf.${sessionKey}._o_.s`)).toBeNull();
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'offline-opfs-clear-session'
  `);
}, 10_000);
