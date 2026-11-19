import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act } from 'react';
import { rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CollectionOfflineOperationDefinition } from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  pick,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import {
  getOfflineQueueEntries,
  getSortedQueueSummary,
  type PatchUserOperations,
  type UpdateValueExecuteContext,
  type UpdateValueOperations,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  collectionSchema,
  docMutationInputSchema,
  docSchema,
  getGlobalOfflineStatusSummary,
  listQueryQueryPayloadSchema,
} from './offlineTestShared';

let network = createOfflineNetworkMock();

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

// Offline session gate (`offlineSession.enabled`): the app can turn the whole
// offline layer off at runtime (feature flag, per-workspace setting...)
// without recreating the store manager. While the gate is closed the session
// must behave as if no offline session existed.

test('closed gate: a document store ignores the lost connection and runs offline-enabled mutations as plain online mutations', async () => {
  const sessionKey = 'gate-closed-document';
  const storeName = 'gate-closed-document-store';
  // Would put the session in network offline mode if it were ever consulted.
  const classifyFailure = vi.fn(() => 'network' as const);
  const replayedInputs: { value: number }[] = [];
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: {
      // The app keeps the offline layer turned off.
      enabled: () => false,
      classifyFailure,
      network: network.config,
    },
  });

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: storeName,
    getSessionKey: () => sessionKey,
    storeManager,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            execute: async ({ input }: UpdateValueExecuteContext) => {
              replayedInputs.push(input);
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

  // -- The browser loses its connection --
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  // Network detection is ignored: the session never enters offline mode and
  // reports both modes as not enabled.
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'gate-closed-document'
  `);
  expect(storeManager.getOfflineRuntimeConfig()).toMatchInlineSnapshot(`
    mutationQueueing: { network: 'allow', outage: 'allow' }
    network: { enabled: '❌' }
    outage: { enabled: '❌' }
  `);

  // -- Reads --
  // A fetch still goes to the server instead of being answered as "offline".
  const fetchesBeforeRead = env.serverMock.fetchHistory.length;
  env.scheduleFetch('highPriority');
  await flushAllTimers();

  expect(env.serverMock.fetchHistory).toHaveLength(fetchesBeforeRead + 1);

  // A failed fetch surfaces as a normal error and is not classified.
  env.serverMock.setNextFetchError('server down');
  env.scheduleFetch('highPriority');
  await flushAllTimers();

  expect(pick(env.store.state, ['data', 'error', 'status']))
    .toMatchInlineSnapshot(`
      data: { value: 1 }
      error: { code: 500, id: 'fetch-error', message: 'server down' }
      status: 'error'
    `);

  // -- Mutation with an `offline` descriptor: success path --
  const directMutation = vi.fn(async () => {
    await env.serverMock.delayedSetData(2);
    return 2;
  });
  const successResult = await resolveAfterAllTimers(
    env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: directMutation,
      offline: { operation: 'updateValue', input: { value: 2 } },
    }),
  );

  // It ran against the server and keeps the offline-enabled result shape.
  expect({
    ok: successResult.ok,
    value: successResult.ok ? successResult.value : null,
  }).toMatchInlineSnapshot(`
    ok: '✅'
    value: { data: 2, kind: 'online' }
  `);
  expect(directMutation).toHaveBeenCalledTimes(1);
  expect(env.store.state.data).toMatchInlineSnapshot(`
    value: 2
  `);

  // -- Mutation with an `offline` descriptor: failure path --
  const failedResult = await env.apiStore.performMutation({
    optimisticUpdate: () => {
      env.apiStore.updateState((draft) => {
        draft.value = 3;
      });
    },
    mutation: () => Promise.reject(new Error('request failed')),
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  // The original error reaches the caller, like in any online mutation...
  expect({ error: failedResult.ok ? null : failedResult.error })
    .toMatchInlineSnapshot(`
      error{Error}:
        message: 'request failed'
        name: 'StoreMutationError'
        kind: 'error'
        code: 500
        id: 'fetch-error'
        cause:
          Error#: { message: 'request failed', name: 'Error' }
    `);
  // ...and the optimistic update is rolled back instead of being kept as
  // pending offline work.
  expect(env.store.state.data).toMatchInlineSnapshot(`
    value: 2
  `);

  // Nothing was queued, replayed or classified at any point.
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(replayedInputs).toMatchInlineSnapshot(`[]`);
  expect(classifyFailure).not.toHaveBeenCalled();
  expect(getGlobalOfflineStatusSummary(sessionKey).isOfflineMode).toBe(false);
});

const renameCollectionInputSchema = rc_object({
  id: rc_string,
  name: rc_string,
});

type RenameCollectionItemOperations = {
  renameItem: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { id: string; name: string }
  >;
};

test('closed gate: a collection store ignores the lost connection and runs offline-enabled mutations as plain online mutations', async () => {
  const sessionKey = 'gate-closed-collection';
  const storeName = 'gate-closed-collection-store';
  // Would put the session in network offline mode if it were ever consulted.
  const classifyFailure = vi.fn(() => 'network' as const);
  const replayedInputs: { id: string; name: string }[] = [];

  const env: ReturnType<
    typeof createCollectionStoreTestEnv<
      { name: string },
      RenameCollectionItemOperations
    >
  > = createCollectionStoreTestEnv<
    { name: string },
    RenameCollectionItemOperations
  >(
    { 'users||1': { name: 'Ada' } },
    {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
          // The app keeps the offline layer turned off.
          enabled: () => false,
          classifyFailure,
          network: network.config,
        },
      }),
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            renameItem: {
              inputSchema: renameCollectionInputSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.id],
              execute: ({ input }) => {
                replayedInputs.push(input);
                return env.serverTable
                  .delayedUpdateItem(input.id, { name: input.name })
                  .then(() => ({ value: { name: input.name } }));
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateItemState(input.id, () => ({
                  value: { name: input.name },
                }));
              },
            },
          },
        },
      },
    },
  );

  await Promise.resolve();

  // -- The browser loses its connection --
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  // Network detection is ignored: the session never enters offline mode.
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'gate-closed-collection'
  `);

  // -- Reads --
  // An item fetch still goes to the server instead of being answered as
  // "offline".
  const itemRequestsBeforeRead =
    env.serverTable.getRequestHistory('item').length;
  env.scheduleFetch('highPriority', 'users||1');
  await flushAllTimers();

  expect(env.serverTable.getRequestHistory('item')).toHaveLength(
    itemRequestsBeforeRead + 1,
  );

  // -- Mutation with an `offline` descriptor: success path --
  const directMutation = vi.fn(() =>
    env.serverTable
      .delayedUpdateItem('users||1', { name: 'Grace' })
      .then(() => ({ value: { name: 'Grace' } })),
  );
  const successResult = await resolveAfterAllTimers(
    env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', () => ({
          value: { name: 'Grace' },
        }));
      },
      mutation: directMutation,
      offline: {
        operation: 'renameItem',
        input: { id: 'users||1', name: 'Grace' },
      },
    }),
  );

  // It ran against the server and keeps the offline-enabled result shape.
  expect({
    ok: successResult.ok,
    value: successResult.ok ? successResult.value : null,
  }).toMatchInlineSnapshot(`
    ok: '✅'

    value:
      data:
        value: { name: 'Grace' }
      kind: 'online'
  `);
  expect(directMutation).toHaveBeenCalledTimes(1);
  expect(env.serverTable.get('users||1')).toMatchInlineSnapshot(`
    name: 'Grace'
  `);

  // -- Mutation with an `offline` descriptor: failure path --
  const failedResult = await env.apiStore.performMutation('users||1', {
    optimisticUpdate: () => {
      env.apiStore.updateItemState('users||1', () => ({
        value: { name: 'Linus' },
      }));
    },
    mutation: () => Promise.reject(new Error('request failed')),
    offline: {
      operation: 'renameItem',
      input: { id: 'users||1', name: 'Linus' },
    },
  });

  // The original error reaches the caller, like in any online mutation...
  expect({ error: failedResult.ok ? null : failedResult.error })
    .toMatchInlineSnapshot(`
      error{Error}:
        message: 'request failed'
        name: 'StoreMutationError'
        kind: 'error'
        code: 500
        id: 'fetch-error'
        cause:
          Error#: { message: 'request failed', name: 'Error' }
    `);
  // ...and the optimistic rename is rolled back instead of being kept as
  // pending offline work.
  expect(env.apiStore.getItemState('users||1')?.data).toMatchInlineSnapshot(`
    value: { name: 'Grace' }
  `);

  // Nothing was queued, replayed or classified at any point.
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(replayedInputs).toMatchInlineSnapshot(`[]`);
  expect(classifyFailure).not.toHaveBeenCalled();
  expect(getGlobalOfflineStatusSummary(sessionKey).isOfflineMode).toBe(false);
});

test('a list query store follows the gate on its next fetch or mutation, without the app calling anything', async () => {
  const sessionKey = 'gate-flips-list-query';
  const storeName = 'gate-flips-list-query-store';
  const usersQuery = { tableId: 'users' } as const;
  // Would put the session in network offline mode if it were ever consulted.
  const classifyFailure = vi.fn(() => 'network' as const);
  const replayedInputs: { itemId: string; name: string }[] = [];
  const statusChanges = createLoggerStore();
  // The flag the app flips at runtime.
  let offlineEnabled = true;

  const env: ReturnType<
    typeof createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      PatchUserOperations
    >
  > = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    PatchUserOperations
  >(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
          enabled: () => offlineEnabled,
          classifyFailure,
          network: network.config,
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
            patchUserName: {
              inputSchema: userPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: ({ input }) => {
                replayedInputs.push(input);
                return env.serverTable
                  .delayedUpdateItem(input.itemId, { name: input.name })
                  .then(() => ({ name: input.name }));
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

  await flushAllTimers();

  // -- Gate open: the lost connection puts the session in offline mode --
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();
  statusChanges.addMark('Gate open, browser goes offline');
  statusChanges.add(getGlobalOfflineStatusSummary(sessionKey));

  // Fetches are answered as "offline" and never reach the server.
  const listRequestsWhileOffline =
    env.serverTable.getRequestHistory('list').length;
  env.scheduleFetch('highPriority', usersQuery);
  await flushAllTimers();

  expect(env.serverTable.getRequestHistory('list')).toHaveLength(
    listRequestsWhileOffline,
  );

  // -- The app closes the gate and calls nothing else --
  offlineEnabled = false;

  // The next fetch reads the gate: it reaches the server and the session
  // leaves offline mode.
  env.scheduleFetch('highPriority', usersQuery);
  await flushAllTimers();
  statusChanges.addMark('Gate closed, next fetch');
  statusChanges.add(getGlobalOfflineStatusSummary(sessionKey));

  expect(env.serverTable.getRequestHistory('list')).toHaveLength(
    listRequestsWhileOffline + 1,
  );

  // Mutation with an `offline` descriptor, success path: runs online.
  const directMutation = vi.fn(() =>
    env.serverTable
      .delayedUpdateItem('users||1', { name: 'Grace' })
      .then(() => ({ name: 'Grace' })),
  );
  const successResult = await resolveAfterAllTimers(
    env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', (item) => ({
          ...item,
          name: 'Grace',
        }));
      },
      mutation: directMutation,
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Grace' },
      },
    }),
  );

  expect({
    ok: successResult.ok,
    value: successResult.ok ? successResult.value : null,
  }).toMatchInlineSnapshot(`
    ok: '✅'

    value:
      data: { name: 'Grace' }
      kind: 'online'
  `);
  expect(directMutation).toHaveBeenCalledTimes(1);

  // Mutation with an `offline` descriptor, failure path: the original error
  // reaches the caller and the optimistic rename is rolled back.
  const failedResult = await env.apiStore.performMutation('users||1', {
    optimisticUpdate: () => {
      env.apiStore.updateItemState('users||1', (item) => ({
        ...item,
        name: 'Linus',
      }));
    },
    mutation: () => Promise.reject(new Error('request failed')),
    offline: {
      operation: 'patchUserName',
      input: { itemId: 'users||1', name: 'Linus' },
    },
  });

  expect({ error: failedResult.ok ? null : failedResult.error })
    .toMatchInlineSnapshot(`
      error{Error}:
        message: 'request failed'
        name: 'StoreMutationError'
        kind: 'error'
        code: 500
        id: 'fetch-error'
        cause:
          Error#: { message: 'request failed', name: 'Error' }
    `);
  expect(env.apiStore.getItemState('users||1')).toMatchInlineSnapshot(`
    id: 1
    name: 'Grace'
  `);

  // While the gate was closed nothing was queued or classified.
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  expect(classifyFailure).not.toHaveBeenCalled();

  // -- The app reopens the gate (the browser is still offline) --
  offlineEnabled = true;

  // The next mutation reads the gate: the session detects the lost
  // connection again and queues the mutation without calling the server.
  const queuedDirectMutation = vi.fn(() => Promise.resolve({ name: 'Linus' }));
  const queuedResult = await env.apiStore.performMutation('users||1', {
    optimisticUpdate: () => {
      env.apiStore.updateItemState('users||1', (item) => ({
        ...item,
        name: 'Linus',
      }));
    },
    mutation: queuedDirectMutation,
    offline: {
      operation: 'patchUserName',
      input: { itemId: 'users||1', name: 'Linus' },
    },
  });
  statusChanges.addMark('Gate reopened, next mutation');
  statusChanges.add(getGlobalOfflineStatusSummary(sessionKey));

  expect({
    ok: queuedResult.ok,
    value: queuedResult.ok ? queuedResult.value : null,
  }).toMatchInlineSnapshot(`
    ok: '✅'
    value: { kind: 'queued' }
  `);
  expect(queuedDirectMutation).not.toHaveBeenCalled();
  expect(getSortedQueueSummary(sessionKey, storeName)).toMatchInlineSnapshot(`
    - input: { itemId: 'users||1', name: 'Linus' }
      operation: 'patchUserName'
  `);
  expect(replayedInputs).toMatchInlineSnapshot(`[]`);

  expect(statusChanges.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> Gate open, browser goes offline

    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: gate-flips-list-query
    └─

    >>> Gate closed, next fetch

    ┌─
    ⋅ isOfflineMode: ❌
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: gate-flips-list-query
    └─

    >>> Gate reopened, next mutation

    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: gate-flips-list-query
    └─
    "
  `);
});

test('mutations queued before the gate closes stay persisted and are replayed once the gate reopens', async () => {
  network.setOffline();
  const sessionKey = 'gate-keeps-queued-work';
  const storeName = 'gate-keeps-queued-work-doc';
  const replayedInputs: { value: number }[] = [];
  const statusChanges = createLoggerStore();
  // The flag the app flips at runtime.
  let offlineEnabled = true;
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: { enabled: () => offlineEnabled, network: network.config },
  });

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: storeName,
    getSessionKey: () => sessionKey,
    storeManager,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            execute: async ({ input }: UpdateValueExecuteContext) => {
              replayedInputs.push(input);
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

  function updateValue(value: number) {
    return env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = value;
        });
      },
      mutation: async () => {
        await env.serverMock.delayedSetData(value);
        return value;
      },
      offline: { operation: 'updateValue', input: { value } },
    });
  }

  await Promise.resolve();
  statusChanges.addMark('Gate open, browser offline');
  statusChanges.add(getGlobalOfflineStatusSummary(sessionKey));

  // -- Gate open and offline: the mutation is queued --
  await updateValue(2);

  const queuedEntries = getOfflineQueueEntries(sessionKey, storeName);
  expect(getSortedQueueSummary(sessionKey, storeName)).toMatchInlineSnapshot(`
    - input: { value: 2 }
      operation: 'updateValue'
  `);

  // -- The app closes the gate while still offline --
  offlineEnabled = false;
  // Any runtime config update makes the session re-read the gate right away,
  // without waiting for the next fetch or mutation.
  storeManager.setOfflineRuntimeConfig({}).unwrap();
  await Promise.resolve();
  statusChanges.addMark('Gate closed');
  statusChanges.add(getGlobalOfflineStatusSummary(sessionKey));

  // -- The browser reconnects while the gate is closed --
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();
  statusChanges.addMark('Browser reconnects while the gate is closed');
  statusChanges.add(getGlobalOfflineStatusSummary(sessionKey));

  // The queued mutation is neither replayed nor dropped: it stays persisted
  // exactly as it was queued.
  expect(replayedInputs).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toEqual(queuedEntries);
  expect(env.serverMock.current).toMatchInlineSnapshot(`1`);

  // -- The app reopens the gate while online --
  offlineEnabled = true;
  storeManager.setOfflineRuntimeConfig({}).unwrap();
  await flushAllTimers();
  statusChanges.addMark('Gate reopened');
  statusChanges.add(getGlobalOfflineStatusSummary(sessionKey));

  // The mutation queued before the gate closed finally reaches the server.
  expect(replayedInputs).toMatchInlineSnapshot(`
    - value: 2
  `);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  expect(env.serverMock.current).toMatchInlineSnapshot(`2`);

  // -- Normal offline behavior is back --
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();
  statusChanges.addMark('Browser goes offline with the gate open');
  statusChanges.add(getGlobalOfflineStatusSummary(sessionKey));

  const queuedResult = await updateValue(3);

  expect({
    ok: queuedResult.ok,
    value: queuedResult.ok ? queuedResult.value : null,
  }).toMatchInlineSnapshot(`
    ok: '✅'
    value: { kind: 'queued' }
  `);
  expect(getSortedQueueSummary(sessionKey, storeName)).toMatchInlineSnapshot(`
    - input: { value: 3 }
      operation: 'updateValue'
  `);

  expect(statusChanges.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> Gate open, browser offline

    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: gate-keeps-queued-work
    └─

    >>> Gate closed

    ┌─
    ⋅ isOfflineMode: ❌
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: gate-keeps-queued-work
    └─

    >>> Browser reconnects while the gate is closed

    ┌─
    ⋅ isOfflineMode: ❌
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: gate-keeps-queued-work
    └─

    >>> Gate reopened

    ┌─
    ⋅ isOfflineMode: ❌
    ⋅ network: {enabled:✅, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: gate-keeps-queued-work
    └─

    >>> Browser goes offline with the gate open

    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: gate-keeps-queued-work
    └─
    "
  `);
});

test('a queued mutation that fails because the gate closed mid-replay stays queued and is replayed after the gate reopens', async () => {
  network.setOffline();
  const sessionKey = 'gate-closes-mid-replay';
  const storeName = 'gate-closes-mid-replay-doc';
  const replayAttempts: string[] = [];
  // The flag the app flips at runtime.
  let offlineEnabled = true;
  // Makes the replay request that is in flight fail, like a dropped request.
  let failInFlightReplay = false;
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: { enabled: () => offlineEnabled, network: network.config },
  });

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: storeName,
    getSessionKey: () => sessionKey,
    storeManager,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            execute: async ({ input }: UpdateValueExecuteContext) => {
              // Default mutation duration of the server mock.
              await new Promise((resolve) => {
                setTimeout(resolve, 1200);
              });
              if (failInFlightReplay) {
                replayAttempts.push('failed');
                throw new Error('request dropped');
              }
              replayAttempts.push('succeeded');
              env.serverMock.setData(input.value);
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

  // -- Setup: a mutation queued while offline with the gate open --
  await env.apiStore.performMutation({
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
  });

  // -- The browser reconnects and the replay request starts --
  act(() => {
    network.goOnline();
  });
  await advanceTime(600);

  // -- The app closes the gate while that request is in flight, and the
  // request fails --
  offlineEnabled = false;
  failInFlightReplay = true;
  await flushAllTimers();

  // With the gate closed the failure cannot be classified, so the mutation
  // must not be treated as a failed replay (which would ask the user for a
  // manual resolution): it goes back to the queue as pending.
  expect(replayAttempts).toMatchInlineSnapshot(`['failed']`);
  expect(
    getSortedQueueSummary(sessionKey, storeName, [
      'input',
      'operation',
      'syncState',
    ]),
  ).toMatchInlineSnapshot(`
    - input: { value: 2 }
      operation: 'updateValue'
      syncState: 'pending'
  `);
  expect(storeManager.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

  // -- The app reopens the gate and the request works again --
  offlineEnabled = true;
  failInFlightReplay = false;
  storeManager.setOfflineRuntimeConfig({}).unwrap();
  await flushAllTimers();

  // The mutation is replayed and reaches the server.
  expect(replayAttempts).toMatchInlineSnapshot(`['failed', 'succeeded']`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  expect(storeManager.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.serverMock.current).toMatchInlineSnapshot(`2`);
});

test('failures are not classified while both network and outage modes are disabled', async () => {
  const sessionKey = 'classification-skipped-without-modes';
  const storeName = 'classification-skipped-without-modes-doc';
  // Phases of the failures the app was asked to classify.
  const classifiedPhases: string[] = [];
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: {
      classifyFailure: (_error, ctx) => {
        classifiedPhases.push(ctx.phase);
        return 'ignore';
      },
      // Both modes are configured but turned off.
      network: { ...network.config, enabled: false },
      outage: { enabled: false, recoveryCheck: () => true },
    },
  });

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: storeName,
    getSessionKey: () => sessionKey,
    storeManager,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            execute: async ({ input }: UpdateValueExecuteContext) => {
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

  function failingValueUpdate(value: number) {
    return env.apiStore.performMutation({
      mutation: () => Promise.reject(new Error('request failed')),
      offline: { operation: 'updateValue', input: { value } },
    });
  }

  await Promise.resolve();

  // -- Both modes disabled: no classification could change anything --
  env.serverMock.setNextFetchError('server down');
  env.scheduleFetch('highPriority');
  await flushAllTimers();

  const failedResult = await failingValueUpdate(2);

  // Neither the failed fetch nor the failed mutation asked the app to
  // classify the failure, and the mutation failed like an online one.
  expect(classifiedPhases).toMatchInlineSnapshot(`[]`);
  expect(failedResult.ok).toBe(false);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'classification-skipped-without-modes'
  `);

  // -- Enabling a mode at runtime: failures are classified again --
  storeManager.setOfflineRuntimeConfig({ outage: { enabled: true } }).unwrap();

  await failingValueUpdate(3);

  expect(classifiedPhases).toMatchInlineSnapshot(`['mutation']`);
});
