import { sleep } from '@ls-stack/utils/sleep';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  type CollectionOfflineOperationDefinition,
  getGlobalOfflineStatus,
} from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
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
import { resetSessionForTests } from '../utils/resetSessionForTests';
import {
  createHealthCheckMock,
  HEALTH_CHECK_DURATION_MS,
  healthRecoveryProbe,
} from './offlineHealthCheckTestShared';
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

test('an offline-enabled mutation made after the gate closes also clears the offline status', async () => {
  const sessionKey = 'gate-closed-mutation-clears-status';
  const storeName = 'gate-closed-mutation-clears-status-doc';
  const statusChanges = createLoggerStore();
  // The flag the app flips at runtime.
  let offlineEnabled = true;
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: {
      enabled: () => offlineEnabled,
      // Every failed request means the backend is down.
      classifyFailure: () => 'outage',
      outage: {
        enabled: true,
        // The backend stays down, checked once a minute
        recoveryCheck: () => false,
        recoveryProbe: { initialIntervalMs: 60_000, jitterRatio: 0 },
      },
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
          },
        },
      },
    },
  });

  await Promise.resolve();

  // -- The backend goes down: a failed mutation puts the session in outage --
  const queuedResult = await env.apiStore.performMutation({
    mutation: () => Promise.reject(new Error('bad gateway')),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  expect(queuedResult.ok && queuedResult.value).toMatchInlineSnapshot(`
    kind: 'queued'
  `);
  statusChanges.addMark('Backend down');
  statusChanges.add(getGlobalOfflineStatusSummary(sessionKey));

  // -- The app closes the gate without calling anything, then the user edits
  // the document again --
  offlineEnabled = false;
  const onlinePromise = env.apiStore.performMutation({
    mutation: async () => {
      await env.serverMock.delayedSetData(3);
      return 3;
    },
    offline: { operation: 'updateValue', input: { value: 3 } },
  });
  // The server takes 1.2s to save it
  await advanceTime(1_200);
  const onlineResult = await onlinePromise;

  // The mutation went straight to the server, as without an offline session
  expect(onlineResult.ok && onlineResult.value).toMatchInlineSnapshot(`
    data: 3
    kind: 'online'
  `);
  expect(env.serverMock.current).toMatchInlineSnapshot(`3`);

  // The status the UI renders follows the closed gate too, instead of still
  // reporting the outage while mutations already go to the server
  statusChanges.addMark('Mutation after the gate closed');
  statusChanges.add(getGlobalOfflineStatusSummary(sessionKey));

  expect(statusChanges.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> Backend down

    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:✅, active:✅}
    ⋅ sessionKey: gate-closed-mutation-clears-status
    └─

    >>> Mutation after the gate closed

    ┌─
    ⋅ isOfflineMode: ❌
    ⋅ network: {enabled:❌, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: gate-closed-mutation-clears-status
    └─
    "
  `);
});

test('mutations queued during an outage are replayed when the gate reopens, even if a recovery check was due while it was closed', async () => {
  const sessionKey = 'gate-closed-during-outage-probe';
  const storeName = 'gate-closed-during-outage-probe-doc';
  const health = createHealthCheckMock();
  const replayedInputs: { value: number }[] = [];
  // The flag the app flips at runtime.
  let offlineEnabled = true;
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: {
      enabled: () => offlineEnabled,
      healthCheck: { check: health.check },
      network: network.config,
      outage: { enabled: true, recoveryProbe: healthRecoveryProbe },
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
          },
        },
      },
    },
  });

  await Promise.resolve();

  // -- The backend goes down: the failed mutation is queued and the health
  // check puts the session in outage mode --
  health.setBackend('outage');
  const queuedPromise = env.apiStore.performMutation({
    mutation: () => Promise.reject(new Error('bad gateway')),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });
  await advanceTime(HEALTH_CHECK_DURATION_MS);
  const queuedResult = await queuedPromise;

  expect(queuedResult.ok && queuedResult.value).toMatchInlineSnapshot(`
    kind: 'queued'
  `);
  expect(getGlobalOfflineStatusSummary(sessionKey).outage)
    .toMatchInlineSnapshot(`
    active: '✅'
    enabled: '✅'
  `);
  const healthChecksBeforeClosing = health.check.mock.calls.length;

  // -- The app closes the gate without calling anything, and the next
  // recovery check comes due --
  offlineEnabled = false;
  await advanceTime(1_500);

  // The health endpoint is not called while the gate is closed
  expect(health.check.mock.calls.length - healthChecksBeforeClosing).toBe(0);
  expect(replayedInputs).toMatchInlineSnapshot(`[]`);

  // -- The backend recovers and the app reopens the gate; the next fetch
  // re-reads it --
  health.setBackend('up');
  offlineEnabled = true;
  env.scheduleFetch('highPriority');
  await flushAllTimers();

  // The mutation queued during the outage finally reaches the server
  expect(replayedInputs).toMatchInlineSnapshot(`- value: 2`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  expect(env.serverMock.current).toMatchInlineSnapshot(`2`);
});

test('load more reaches the server once the gate closes, even while the browser is still offline', async () => {
  const sessionKey = 'gate-closed-load-more';
  const usersQuery = { tableId: 'users' } as const;
  // The flag the app flips at runtime.
  let offlineEnabled = true;
  const env = createListQueryStoreTestEnv(
    {
      users: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
        { id: 3, name: 'Linus' },
      ],
    },
    {
      defaultQuerySize: 2,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
          enabled: () => offlineEnabled,
          network: network.config,
        },
      }),
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: { operations: {} },
      },
    },
  );

  function getLoadedUserNames() {
    const query = env.apiStore.getQueryState(usersQuery);
    return {
      names: (query?.items ?? []).map(
        (itemKey) => env.store.state.items[itemKey]?.name,
      ),
      hasMore: query?.hasMore,
    };
  }

  // -- Setup: the first page is loaded online and has more items --
  env.scheduleFetch('highPriority', usersQuery);
  await flushAllTimers();
  expect(getLoadedUserNames()).toMatchInlineSnapshot(`
    hasMore: '✅'
    names: ['Ada', 'Grace']
  `);

  // -- The browser goes offline: the session enters offline mode --
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();
  expect(getGlobalOfflineStatusSummary(sessionKey).isOfflineMode).toBe(true);
  const listRequestsBefore = env.serverTable.getRequestHistory('list').length;

  // -- The app closes the gate and calls nothing else --
  offlineEnabled = false;

  // Load more is a fetch: it reads the gate, so it is sent to the server
  // like with no offline session, instead of paging the offline cache
  expect(env.apiStore.loadMore(usersQuery)).toBe('triggered');
  await flushAllTimers();

  expect(env.serverTable.getRequestHistory('list')).toHaveLength(
    listRequestsBefore + 1,
  );
  expect(getLoadedUserNames()).toMatchInlineSnapshot(`
    hasMore: '❌'
    names: ['Ada', 'Grace', 'Linus']
  `);
  // The closed gate is applied to the status too
  expect(getGlobalOfflineStatusSummary(sessionKey).isOfflineMode).toBe(false);
});

test('queued mutations left behind when the gate closes mid-replay are replayed once it reopens', async () => {
  network.setOffline();
  const sessionKey = 'gate-closes-between-replays';
  const storeName = 'gate-closes-between-replays-doc';
  const replayedInputs: { value: number }[] = [];
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
          },
        },
      },
    },
  });

  await Promise.resolve();

  // -- Setup: two mutations queued while offline with the gate open --
  for (const value of [2, 3]) {
    await env.apiStore.performMutation({
      mutation: async () => {
        await env.serverMock.delayedSetData(value);
        return value;
      },
      offline: { operation: 'updateValue', input: { value } },
    });
  }
  expect(getSortedQueueSummary(sessionKey, storeName, ['input']))
    .toMatchInlineSnapshot(`
    - input: { value: 2 }
    - input: { value: 3 }
  `);

  // -- The browser reconnects and the first replay request starts --
  act(() => {
    network.goOnline();
  });
  await advanceTime(600);

  // -- The app closes the gate while that request is in flight; it
  // succeeds, and the second mutation waits for the gate --
  offlineEnabled = false;
  await flushAllTimers();

  expect(replayedInputs).toMatchInlineSnapshot(`- value: 2`);
  expect(
    getSortedQueueSummary(sessionKey, storeName, ['input']),
  ).toMatchInlineSnapshot(`- input: { value: 3 }`);

  // -- The app reopens the gate and asks for it to apply right away --
  offlineEnabled = true;
  storeManager.setOfflineRuntimeConfig({}).unwrap();
  await flushAllTimers();

  // The mutation left behind is replayed
  expect(replayedInputs).toMatchInlineSnapshot(`
    - value: 2
    - value: 3
  `);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  expect(env.serverMock.current).toMatchInlineSnapshot(`3`);
});

test('a request failing right after the gate reopens puts the session in network mode until the recovery check passes', async () => {
  const sessionKey = 'gate-reopens-mid-fetch';
  const usersQuery = { tableId: 'users' } as const;
  const recoveryCheck = vi.fn(() => false);
  // The flag the app flips at runtime: the offline layer starts turned off.
  let offlineEnabled = false;
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: {
      enabled: () => offlineEnabled,
      // The app recognizes the failure as a lost connection
      classifyFailure: () => 'network' as const,
      network: { ...network.config, recoveryCheck },
    },
  });
  const env = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      getSessionKey: () => sessionKey,
      storeManager,
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: { operations: {} },
      },
    },
  );

  // -- A list fetch starts with the gate closed --
  env.serverTable.setNextListFetchError('connection reset');
  env.scheduleFetch('highPriority', usersQuery);
  await advanceTime(400);

  // -- The app reopens the gate while the request is in flight, and the
  // request fails --
  offlineEnabled = true;
  await advanceTime(600);

  // The failure is classified with the gate open: network mode is active
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'gate-reopens-mid-fetch'
  `);

  // Reading the status re-checks the network: the browser still reports
  // online, but the request failure keeps network mode until the recovery
  // check says otherwise
  expect(storeManager.getOfflineStatus().isOfflineMode).toBe(true);

  // The recovery check runs on the network probe cadence (5s by default)
  await advanceTime(6_000);
  expect(recoveryCheck).toHaveBeenCalledTimes(1);
});

test('a failure whose classification is still running when the gate closes does not call the health endpoint', async () => {
  const sessionKey = 'gate-closed-during-classification';
  const health = createHealthCheckMock();
  // The flag the app flips at runtime.
  let offlineEnabled = true;
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: {
      enabled: () => offlineEnabled,
      // The app's classifier needs time to decide (e.g. it reads the error
      // response body) and then defers to the health check
      classifyFailure: async () => {
        await sleep(200);
        return 'unknown' as const;
      },
      healthCheck: { check: health.check },
      network: network.config,
      outage: { enabled: true },
    },
  });

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: 'gate-closed-during-classification-doc',
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
          },
        },
      },
    },
  });

  await Promise.resolve();

  // -- A mutation fails while the backend is down; the app closes the gate
  // while the classifier is still deciding --
  health.setBackend('outage');
  const resultPromise = env.apiStore.performMutation({
    mutation: () => Promise.reject(new Error('bad gateway')),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });
  await advanceTime(100);
  offlineEnabled = false;
  const result = await resolveAfterAllTimers(resultPromise);

  // The gate was closed by the time the classifier answered: the health
  // endpoint is not called and the failure stays a plain request error
  expect(health.check).not.toHaveBeenCalled();
  expect(result.ok).toBe(false);
  expect(getGlobalOfflineStatusSummary(sessionKey).outage)
    .toMatchInlineSnapshot(`
      active: '❌'
      enabled: '❌'
    `);
});

test('closed gate: the status still reports a lost connection, so the app can show it to users without offline mode', async () => {
  const sessionKey = 'gate-closed-connectivity';
  // The flag the app flips at runtime: this user's plan has no offline mode.
  let offlineEnabled = false;
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: { enabled: () => offlineEnabled, network: network.config },
  });
  const statusChanges = createLoggerStore();

  // The app's "No connection" banner, rendered from the offline status only
  const banner = renderHook(() => {
    const status = storeManager.useOfflineStatus();
    statusChanges.add(
      pick(status, ['isNetworkDetectedOffline', 'isOfflineMode', 'network']),
    );
  });

  // -- The browser loses its connection while the gate is closed --
  statusChanges.addMark('Gate closed, browser goes offline');
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  // -- The browser reconnects --
  statusChanges.addMark('Gate closed, browser reconnects');
  act(() => {
    network.goOnline();
  });
  await Promise.resolve();

  // -- The browser goes offline again, and the user's plan gets offline mode
  // meanwhile --
  statusChanges.addMark('Browser goes offline again, then the gate opens');
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();
  offlineEnabled = true;
  act(() => {
    storeManager.setOfflineRuntimeConfig({});
  });
  await Promise.resolve();

  // The detected connectivity is reported in every phase, while offline mode
  // (and `network.active`) only follows it once the gate is open
  expect(statusChanges.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> isNetworkDetectedOffline: ❌ ⋅ isOfflineMode: ❌ ⋅ network: {enabled:❌, active:❌}

    >>> Gate closed, browser goes offline

    -> isNetworkDetectedOffline: ✅ ⋅ isOfflineMode: ❌ ⋅ network: {enabled:❌, active:❌}

    >>> Gate closed, browser reconnects

    -> isNetworkDetectedOffline: ❌ ⋅ isOfflineMode: ❌ ⋅ network: {enabled:❌, active:❌}

    >>> Browser goes offline again, then the gate opens

    -> isNetworkDetectedOffline: ✅ ⋅ isOfflineMode: ❌ ⋅ network: {enabled:❌, active:❌}
    -> isNetworkDetectedOffline: ✅ ⋅ isOfflineMode: ✅ ⋅ network: {enabled:✅, active:✅}
    "
  `);

  banner.unmount();
});

test('closed gate: an async connectivity check updates the reported connection without delaying fetches', async () => {
  const sessionKey = 'gate-closed-async-connectivity';
  // The app's connectivity check pings an endpoint and takes 300ms
  const getIsOffline = vi.fn(async () => {
    await sleep(300);
    return network.isOffline();
  });
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: {
      enabled: () => false,
      network: { enabled: true, getIsOffline },
    },
  });
  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    storeManager,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {},
    },
  });
  await flushAllTimers();

  // -- The connection drops and the app refetches --
  network.setOffline();
  env.serverMock.setFetchDurations(100);
  env.scheduleFetch('highPriority');

  // The fetch is not held back by the 300ms check: it goes to the server right
  // away and settles after its own 100ms. (The status is read without the
  // manager here: reading it through the manager re-checks the connectivity.)
  await advanceTime(150);
  expect(env.store.state.status).toBe('success');
  expect(getGlobalOfflineStatus(sessionKey).isNetworkDetectedOffline).toBe(
    false,
  );

  // The check answers in the background and the status reports the lost
  // connection, without entering offline mode
  await advanceTime(200);
  expect(
    pick(getGlobalOfflineStatus(sessionKey), [
      'isNetworkDetectedOffline',
      'isOfflineMode',
    ]),
  ).toMatchInlineSnapshot(`
    isNetworkDetectedOffline: '✅'
    isOfflineMode: '❌'
  `);
});

test('closed gate: a connectivity check that throws does not fail fetches of users without offline mode', async () => {
  const sessionKey = 'gate-closed-throwing-connectivity';
  // The app's connectivity check reads a realtime connection that is not set
  // up yet, so it throws
  const getIsOffline = vi.fn((): boolean => {
    throw new Error('realtime connection not ready');
  });
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: {
      enabled: () => false,
      network: { enabled: true, getIsOffline },
    },
  });
  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    storeManager,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {},
    },
  });
  await flushAllTimers();

  // -- The app refetches --
  const fetchesBeforeRefetch = env.serverMock.fetchHistory.length;
  env.scheduleFetch('highPriority');
  await flushAllTimers();

  // The closed gate only runs the check to report the connection, so its
  // error doesn't reach the fetch: the fetch still loads from the server, and
  // the status keeps its last known connection
  expect(getIsOffline).toHaveBeenCalled();
  expect(env.serverMock.fetchHistory).toHaveLength(fetchesBeforeRefetch + 1);
  expect(env.store.state.status).toBe('success');
  expect(env.store.state.error).toBe(null);
  expect(
    pick(getGlobalOfflineStatus(sessionKey), [
      'isNetworkDetectedOffline',
      'isOfflineMode',
    ]),
  ).toMatchInlineSnapshot(`
    isNetworkDetectedOffline: '❌'
    isOfflineMode: '❌'
  `);
});
