import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { CollectionOfflineOperationDefinition } from '../../src/main';
import { createOfflineSession } from '../../src/main';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import {
  type CreateUserOperations,
  deleteItemInputSchema,
  getLocalStorageKeys,
  getOfflineQueueEntries,
  getOfflineQueueEntryData,
  type UpdateValueConflictOperations,
  type UpdateValueOperations,
  userPatchSchema,
} from './offlineReplayTestShared';
import {
  classifyMutationOutage,
  collectionCreateInputSchema,
  collectionSchema,
  docMutationInputSchema,
  docSchema,
  quickRecoveryProbe,
  waitForMicrotaskCondition,
} from './offlineTestShared';

function trackDocumentReplayState(env: {
  apiStore: {
    getOfflineEntities: () => Array<{
      pendingMutations?: number;
      syncState?: string;
    }>;
  };
  store: { state: { data: { value: number } | null } };
  trackUIChanges: (value: string) => void;
}) {
  const offlineEntity = env.apiStore.getOfflineEntities()[0];

  env.trackUIChanges(
    `value:${env.store.state.data?.value ?? 'null'} sync:${
      offlineEntity?.syncState ?? 'none'
    } pending:${offlineEntity?.pendingMutations ?? 0}`,
  );
}

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

test('collection offline creates keep durable temp-id metadata and clear after replay finishes', async () => {
  network.setOffline();
  const resolveCreates: Array<(result: { id: string; name: string }) => void> =
    [];

  const env = createCollectionStoreTestEnv<
    { name: string },
    CreateUserOperations
  >(
    { 'users||1': { name: 'User 1' } },
    {
      getSessionKey: () => 'offline-temp-id-session',
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => 'offline-temp-id-session',
            config: { network: network.config },
          }),
          operations: {
            createUser: {
              inputSchema: collectionCreateInputSchema,
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              accumulation: {
                mergeInput: ({ incomingInput }) => incomingInput,
              },
              tempEntity: {
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
    network.goOffline();
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

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: '"temp:Ada'
      entityKind: 'item'
      id: 'offline-temp-id-session:collection-1:"temp:Ada'
      pendingMutations: 2
      requiresResolution: '❌'
      sessionKey: 'offline-temp-id-session'
      storeName: 'collection-1'
      storeType: 'collection'
      syncState: 'pending'
      tempId: 'temp:Ada'
      updatedAt: 1735689600000
  `);

  act(() => {
    network.goOnline();
  });
  await waitForMicrotaskCondition(() => resolveCreates.length > 0);
  expect(resolveCreates).toHaveLength(1);
  resolveCreates[0]?.({ id: 'users||ada', name: 'Ada' });
  await vi.runAllTimersAsync();
  await Promise.resolve();
  expect(resolveCreates).toHaveLength(2);
  resolveCreates[1]?.({ id: 'users||ada-2', name: 'Ada' });
  await flushAllTimers();

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
});

test('document offline accumulation keeps a single persisted queue entry and replays only the merged input', async () => {
  network.setOffline();
  const sessionKey = 'offline-accumulation-session';
  const storeName = 'offline-accumulation-doc';
  const execute = vi
    .fn<
      ({
        input,
        enqueuedAt,
      }: {
        input: { value: number };
        enqueuedAt: number;
      }) => { value: number }
    >()
    .mockImplementation(({ input, enqueuedAt }) => {
      expect(enqueuedAt).toBe(TEST_INITIAL_TIME);
      env.apiStore.updateState((draft) => {
        draft.value = input.value;
      });

      return input;
    });

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
            accumulation: { mergeInput: ({ incomingInput }) => incomingInput },
            execute,
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

  await advanceTime(50);
  await env.apiStore.performMutation({
    optimisticUpdate: () => {
      env.apiStore.updateState((draft) => {
        draft.value = 3;
      });
    },
    mutation: () => Promise.resolve(3),
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  expect(env.store.state.data).toMatchInlineSnapshot(`
    value: 3
  `);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: 'document'
      entityKind: 'document'
      id: 'offline-accumulation-session:offline-accumulation-doc:document'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'offline-accumulation-session'
      storeName: 'offline-accumulation-doc'
      storeType: 'document'
      syncState: 'pending'
      updatedAt: 1735689600050
  `);
  expect(
    getOfflineQueueEntries(sessionKey, storeName).map((entry) => {
      const data = getOfflineQueueEntryData(entry);

      return {
        timestamp: entry.timestamp,
        version: entry.version,
        data: {
          attempts: data.attempts,
          createdAt: data.createdAt,
          entityRefs: data.entityRefs,
          input: data.input,
          lastAttemptAt: data.lastAttemptAt,
          operation: data.operation,
          sessionKey: data.sessionKey,
          storeName: data.storeName,
          storeType: data.storeType,
          syncState: data.syncState,
          updatedAt: data.updatedAt,
        },
      };
    }),
  ).toMatchInlineSnapshot(`
    - data:
        attempts: 0
        createdAt: 1735689600000
        entityRefs:
          - { entityKey: 'document', entityKind: 'document' }
        input: { value: 3 }
        lastAttemptAt: null
        operation: 'updateValue'
        sessionKey: 'offline-accumulation-session'
        storeName: 'offline-accumulation-doc'
        storeType: 'document'
        syncState: 'pending'
        updatedAt: 1735689600050
  `);

  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(execute.mock.calls.map(([ctx]) => ctx.input)).toMatchInlineSnapshot(`
    - value: 3
  `);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
});

test('same-entity supersede keeps only the queued delete for a persisted collection item', async () => {
  network.setOffline();
  const sessionKey = 'offline-supersede-delete-session';
  const storeName = 'offline-supersede-delete-store';
  const patchExecute = vi.fn(
    ({ input }: { input: { itemId: string; name: string } }) => {
      env.apiStore.updateItemState(input.itemId, (item) => ({
        ...item,
        name: input.name,
      }));

      return { name: input.name };
    },
  );
  const deleteExecute = vi.fn(({ input }: { input: { itemId: string } }) => {
    env.apiStore.deleteItemState(input.itemId);
    return undefined;
  });

  type SupersedeCollectionOperations = {
    patchUserName: CollectionOfflineOperationDefinition<
      { value: { name: string } },
      string,
      { itemId: string; name: string },
      unknown
    >;
    deleteUser: CollectionOfflineOperationDefinition<
      { value: { name: string } },
      string,
      { itemId: string },
      unknown
    >;
  };

  const env = createCollectionStoreTestEnv<
    { name: string },
    SupersedeCollectionOperations
  >(
    { 'users||1': { name: 'Ada' } },
    {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => sessionKey,
            config: { network: network.config },
          }),
          operations: {
            patchUserName: {
              inputSchema: userPatchSchema,
              getEntityRefs: ({ input }) => [input.itemId],
              execute: patchExecute,
            },
            deleteUser: {
              inputSchema: deleteItemInputSchema,
              getEntityRefs: ({ input }) => [input.itemId],
              supersedes: { scope: 'same-entity' },
              execute: deleteExecute,
            },
          },
        },
      },
    },
  );

  // Queue an edit first so the later delete can supersede it.
  await env.apiStore.performMutation('users||1', {
    optimisticUpdate: () => {
      env.apiStore.updateItemState('users||1', (item) => ({
        ...item,
        name: 'Ada renamed offline',
      }));
    },
    mutation: () => Promise.resolve({ name: 'Ada renamed offline' }),
    offline: {
      operation: 'patchUserName',
      input: { itemId: 'users||1', name: 'Ada renamed offline' },
    },
  });

  // Queue the delete for the same item. The older edit should be pruned.
  await env.apiStore.performMutation('users||1', {
    optimisticUpdate: () => {
      env.apiStore.deleteItemState('users||1');
    },
    mutation: () => Promise.resolve(undefined),
    offline: { operation: 'deleteUser', input: { itemId: 'users||1' } },
  });

  expect(
    getOfflineQueueEntries(sessionKey, storeName)
      .map((entry) => {
        const data = getOfflineQueueEntryData(entry);

        return {
          input: data.input,
          operation: data.operation,
          queueOrder: data.queueOrder,
        };
      })
      .sort((left, right) => Number(left.queueOrder) - Number(right.queueOrder))
      .map(({ queueOrder: _queueOrder, ...entry }) => entry),
  ).toMatchInlineSnapshot(`
    - input: { itemId: 'users||1' }
      operation: 'deleteUser'
  `);

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: '"users||1'
      entityKind: 'item'
      id: 'offline-supersede-delete-session:offline-supersede-delete-store:"users||1'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'offline-supersede-delete-session'
      storeName: 'offline-supersede-delete-store'
      storeType: 'collection'
      syncState: 'pending'
      updatedAt: 1735689600000
  `);

  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(patchExecute).not.toHaveBeenCalled();
  expect(deleteExecute.mock.calls.map(([ctx]) => ctx.input))
    .toMatchInlineSnapshot(`
      - itemId: 'users||1'
    `);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
});

test('same-entity supersede can prune only the latest-wins operation while keeping unrelated queued work', async () => {
  network.setOffline();
  const sessionKey = 'offline-selective-supersede-session';
  const storeName = 'offline-selective-supersede-store';
  const replayedOperations: Array<
    | { operation: 'setUserRole'; input: { itemId: string; role: string } }
    | { operation: 'setUserName'; input: { itemId: string; name: string } }
  > = [];
  const setUserNameExecute = vi.fn(
    ({ input }: { input: { itemId: string; name: string } }) => {
      replayedOperations.push({ operation: 'setUserName', input });
      env.apiStore.updateItemState(input.itemId, (item) => ({
        ...item,
        name: input.name,
      }));
      return { name: input.name };
    },
  );
  const setUserRoleExecute = vi.fn(
    ({ input }: { input: { itemId: string; role: string } }) => {
      replayedOperations.push({ operation: 'setUserRole', input });
      env.apiStore.updateItemState(input.itemId, (item) => ({
        ...item,
        role: input.role,
      }));
      return { role: input.role };
    },
  );
  const setUserNameInputSchema = rc_object({
    itemId: rc_string,
    name: rc_string,
  });
  const setUserRoleInputSchema = rc_object({
    itemId: rc_string,
    role: rc_string,
  });
  const collectionWithRoleSchema = rc_object({
    value: rc_object({ name: rc_string, role: rc_string }),
  });

  type SelectiveSupersedeCollectionOperations = {
    setUserName: CollectionOfflineOperationDefinition<
      { name: string; role: string },
      string,
      { itemId: string; name: string },
      unknown
    >;
    setUserRole: CollectionOfflineOperationDefinition<
      { name: string; role: string },
      string,
      { itemId: string; role: string },
      unknown
    >;
  };

  const env = createCollectionStoreTestEnv<
    { name: string; role: string },
    SelectiveSupersedeCollectionOperations
  >(
    { 'users||1': { name: 'Ada', role: 'reader' } },
    {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionWithRoleSchema,
        payloadSchema: rc_string,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => sessionKey,
            config: { network: network.config },
          }),
          operations: {
            setUserName: {
              inputSchema: setUserNameInputSchema,
              getEntityRefs: ({ input }) => [input.itemId],
              supersedes: { scope: 'same-entity', operations: 'self' },
              execute: setUserNameExecute,
            },
            setUserRole: {
              inputSchema: setUserRoleInputSchema,
              getEntityRefs: ({ input }) => [input.itemId],
              execute: setUserRoleExecute,
            },
          },
        },
      },
    },
  );

  // Keep an unrelated queued change for the same entity so the test can prove
  // selective supersede does not wipe the whole queue entry chain.
  await env.apiStore.performMutation('users||1', {
    optimisticUpdate: () => {
      env.apiStore.updateItemState('users||1', (item) => ({
        ...item,
        role: 'admin',
      }));
    },
    mutation: () => Promise.resolve({ role: 'admin' }),
    offline: {
      operation: 'setUserRole',
      input: { itemId: 'users||1', role: 'admin' },
    },
  });

  await env.apiStore.performMutation('users||1', {
    optimisticUpdate: () => {
      env.apiStore.updateItemState('users||1', (item) => ({
        ...item,
        name: 'Ada first',
      }));
    },
    mutation: () => Promise.resolve({ name: 'Ada first' }),
    offline: {
      operation: 'setUserName',
      input: { itemId: 'users||1', name: 'Ada first' },
    },
  });

  // Queue a later name change; this should replace only the earlier name
  // update, not the unrelated role change.
  await advanceTime(50);
  await env.apiStore.performMutation('users||1', {
    optimisticUpdate: () => {
      env.apiStore.updateItemState('users||1', (item) => ({
        ...item,
        name: 'Ada latest',
      }));
    },
    mutation: () => Promise.resolve({ name: 'Ada latest' }),
    offline: {
      operation: 'setUserName',
      input: { itemId: 'users||1', name: 'Ada latest' },
    },
  });

  expect(
    getOfflineQueueEntries(sessionKey, storeName)
      .map((entry) => {
        const data = getOfflineQueueEntryData(entry);

        return {
          input: data.input,
          operation: data.operation,
          queueOrder: data.queueOrder,
        };
      })
      .sort((left, right) => Number(left.queueOrder) - Number(right.queueOrder))
      .map(({ queueOrder: _queueOrder, ...entry }) => entry),
  ).toMatchInlineSnapshot(`
    - input: { itemId: 'users||1', role: 'admin' }
      operation: 'setUserRole'
    - input: { itemId: 'users||1', name: 'Ada latest' }
      operation: 'setUserName'
  `);

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: '"users||1'
      entityKind: 'item'
      id: 'offline-selective-supersede-session:offline-selective-supersede-store:"users||1'
      pendingMutations: 2
      requiresResolution: '❌'
      sessionKey: 'offline-selective-supersede-session'
      storeName: 'offline-selective-supersede-store'
      storeType: 'collection'
      syncState: 'pending'
      updatedAt: 1735689600050
  `);

  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(replayedOperations).toMatchInlineSnapshot(`
    - input: { itemId: 'users||1', role: 'admin' }
      operation: 'setUserRole'
    - input: { itemId: 'users||1', name: 'Ada latest' }
      operation: 'setUserName'
  `);
  expect(setUserRoleExecute).toHaveBeenCalledTimes(1);
  expect(setUserNameExecute).toHaveBeenCalledTimes(1);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
});

test('needs-confirmation entries are skipped when shouldSkipSync returns true', async () => {
  network.setOffline();
  let skipCheckEnqueuedAt: number | null = null;

  const execute = vi
    .fn<
      ({
        input,
        enqueuedAt,
      }: {
        input: { value: number };
        enqueuedAt: number;
      }) => Promise<{ value: number }>
    >()
    .mockImplementationOnce(({ input, enqueuedAt }) => {
      expect(enqueuedAt).toBe(TEST_INITIAL_TIME);
      throw new Error(`dispatch failed after send ${input.value}`);
    });
  const shouldSkipSync = vi
    .fn<
      ({
        input,
        enqueuedAt,
      }: {
        input: { value: number };
        enqueuedAt: number;
      }) => Promise<boolean>
    >()
    .mockImplementation(({ input, enqueuedAt }) => {
      skipCheckEnqueuedAt = enqueuedAt;
      expect(input.value).toBe(2);
      return Promise.resolve(true);
    });
  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'needs-confirmation-session',
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () => 'needs-confirmation-session',
          config: { network: network.config },
        }),
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            execute,
            shouldSkipSync,
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

  act(() => {
    network.goOnline();
  });
  await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);
  await advanceTime(5_000);
  await flushAllTimers();

  expect(execute).toHaveBeenCalledTimes(1);
  expect(shouldSkipSync).toHaveBeenCalledTimes(1);
  expect(skipCheckEnqueuedAt).toBe(TEST_INITIAL_TIME);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
});

test('needs-confirmation entries retry execute when shouldSkipSync returns false', async () => {
  network.setOffline();
  let skipCheckEnqueuedAt: number | null = null;
  const execute = vi
    .fn<
      ({
        input,
        enqueuedAt,
      }: {
        input: { value: number };
        enqueuedAt: number;
      }) => Promise<{ value: number }>
    >()
    .mockImplementationOnce(({ input, enqueuedAt }) => {
      expect(enqueuedAt).toBe(TEST_INITIAL_TIME);
      throw new Error(`dispatch failed after send ${input.value}`);
    })
    .mockResolvedValue({ value: 2 });
  const shouldSkipSync = vi
    .fn<
      ({
        input,
        enqueuedAt,
      }: {
        input: { value: number };
        enqueuedAt: number;
      }) => Promise<boolean>
    >()
    .mockImplementation(({ input, enqueuedAt }) => {
      skipCheckEnqueuedAt = enqueuedAt;
      expect(input.value).toBe(2);
      return Promise.resolve(false);
    });

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'needs-confirmation-no-outage-session',
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () => 'needs-confirmation-no-outage-session',
          config: { network: network.config },
        }),
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            execute,
            shouldSkipSync,
          },
        },
      },
    },
  });

  trackDocumentReplayState(env);

  const mutationResult = await env.apiStore.performMutation({
    optimisticUpdate: () => {
      env.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: () => Promise.resolve(2),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });
  trackDocumentReplayState(env);

  expect(mutationResult.ok).toBe(true);

  // The first online replay should settle into syncing before the retry
  // window has a chance to decide whether the queued mutation should continue.
  env.addTimelineComments('beforeNextAction', [
    'bring the session online and wait for the first replay attempt to settle into syncing',
  ]);
  act(() => {
    network.goOnline();
  });
  await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);
  trackDocumentReplayState(env);

  expect(execute).toHaveBeenCalledTimes(1);
  expect(shouldSkipSync).toHaveBeenCalledTimes(0);

  // After the retry window opens, the same queued mutation should replay
  // again instead of staying paused forever.
  env.addTimelineComments('beforeNextAction', [
    'advance the retry window so shouldSkipSync can allow the queued mutation to replay again',
  ]);
  await advanceTime(5_000);
  await flushAllTimers();
  trackDocumentReplayState(env);

  expect(shouldSkipSync).toHaveBeenCalledTimes(1);
  expect(skipCheckEnqueuedAt).toBe(TEST_INITIAL_TIME);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time | ui                               |
    0    | "value:1 sync:none pending:0"    | ui-initialized
    .    | "value:1 sync:none pending:0"    | offline:updateValue queued
    .    | "value:2 sync:pending pending:1" | ui-changed
    .    | "value:2 sync:pending pending:1" | -- bring the session online and wait for the first replay attempt to settle into syncing
    .    | "value:2 sync:pending pending:1" | offline:updateValue replay-started
    .    | "value:2 sync:syncing pending:1" | ui-changed
    5s   | "value:2 sync:syncing pending:1" | -- advance the retry window so shouldSkipSync can allow the queued mutation to replay again
    .    | "value:2 sync:syncing pending:1" | offline:updateValue replay-started
    .    | "value:2 sync:syncing pending:1" | offline:updateValue replay-finished
    .    | "value:2 sync:none pending:0"    | ui-changed
    "
  `);
});

test('healthy replay failures are retried 5 times and then move into the resolution queue', async () => {
  network.setOffline();
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockRejectedValue(new Error('replay failed'));

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'retry-exhaustion-session',
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () => 'retry-exhaustion-session',
          config: { network: network.config },
        }),
        operations: {
          updateValue: { inputSchema: docMutationInputSchema, execute },
        },
      },
    },
  });

  trackDocumentReplayState(env);

  await env.apiStore.performMutation({
    mutation: () => Promise.resolve(2),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });
  trackDocumentReplayState(env);

  // Bring the browser back online so the first replay failure can start the
  // healthy retry budget for this queued mutation.
  env.addTimelineComments('beforeNextAction', [
    'bring the browser back online so the first replay failure starts the healthy retry budget',
  ]);
  act(() => {
    network.goOnline();
  });
  await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);
  trackDocumentReplayState(env);

  // Keep the session online long enough to spend the remaining retry budget.
  env.addTimelineComments('beforeNextAction', [
    'keep the session online long enough to spend the remaining healthy retry budget',
  ]);
  for (const attempt of [2, 3, 4, 5]) {
    await advanceTime(5_000);
    await waitForMicrotaskCondition(
      () => execute.mock.calls.length === attempt,
    );
  }
  await flushAllTimers();
  trackDocumentReplayState(env);

  expect(execute).toHaveBeenCalledTimes(5);

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689620000
      entityKey: 'document'
      entityKind: 'document'
      id: 'retry-exhaustion-session:document-4:document'
      pendingMutations: 0
      requiresResolution: '✅'
      sessionKey: 'retry-exhaustion-session'
      storeName: 'document-4'
      storeType: 'document'
      syncState: 'resolution-required'
      updatedAt: 1735689620000
  `);

  expect(
    env.apiStore
      .getOfflineResolutions()
      .map((resolution) => ({
        ...pick(resolution, [
          'blockedByResolutionIds',
          'blockedResolutionCount',
          'childResolutionCount',
          'childResolutionIds',
          'createdAt',
          'enqueuedAt',
          'entityRefs',
          'input',
          'kind',
          'operation',
          'sessionKey',
          'storeName',
          'storeType',
          'updatedAt',
        ]),
        lastReplayError:
          resolution.kind === 'retry-exhausted'
            ? resolution.lastReplayError
            : null,
      })),
  ).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689620000
      enqueuedAt: 1735689600000
      entityRefs:
        - { entityKey: 'document', entityKind: 'document' }
      input: { value: 2 }
      kind: 'retry-exhausted'
      lastReplayError: { message: 'replay failed' }
      operation: 'updateValue'
      sessionKey: 'retry-exhaustion-session'
      storeName: 'document-4'
      storeType: 'document'
      updatedAt: 1735689620000
  `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time | ui                                           |
    0    | "value:1 sync:none pending:0"                | ui-initialized
    .    | "value:1 sync:none pending:0"                | offline:updateValue queued
    .    | "value:1 sync:pending pending:1"             | ui-changed
    .    | "value:1 sync:pending pending:1"             | -- bring the browser back online so the first replay failure starts the healthy retry budget
    .    | "value:1 sync:pending pending:1"             | offline:updateValue replay-started
    .    | "value:1 sync:syncing pending:1"             | ui-changed
    5s   | "value:1 sync:syncing pending:1"             | -- keep the session online long enough to spend the remaining healthy retry budget
    .    | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    10s  | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    15s  | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    20s  | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .    | "value:1 sync:syncing pending:1"             | offline:updateValue resolution-required
    .    | "value:1 sync:resolution-required pending:0" | ui-changed
    "
  `);
});

test('retry-exhausted resolutions can retry or discard queued work', async () => {
  network.setOffline();
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockRejectedValueOnce(new Error('replay failed'))
    .mockRejectedValueOnce(new Error('replay failed'))
    .mockRejectedValueOnce(new Error('replay failed'))
    .mockRejectedValueOnce(new Error('replay failed'))
    .mockRejectedValueOnce(new Error('replay failed'))
    .mockResolvedValueOnce({ value: 2 })
    .mockRejectedValue(new Error('replay failed'));

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'retry-resolution-actions-session',
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () => 'retry-resolution-actions-session',
          config: { network: network.config },
        }),
        operations: {
          updateValue: { inputSchema: docMutationInputSchema, execute },
        },
      },
    },
  });

  const queueOfflineMutation = () =>
    env.apiStore.performMutation({
      mutation: () => Promise.resolve(2),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

  await queueOfflineMutation();

  act(() => {
    network.goOnline();
  });
  await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);
  for (const attempt of [2, 3, 4, 5]) {
    await advanceTime(5_000);
    await waitForMicrotaskCondition(
      () => execute.mock.calls.length === attempt,
    );
  }
  await flushAllTimers();

  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution || resolution.kind !== 'retry-exhausted') {
    throw new Error('Expected a retry-exhausted resolution');
  }

  expect({
    ...pick(resolution, [
      'blockedByResolutionIds',
      'blockedResolutionCount',
      'childResolutionCount',
      'childResolutionIds',
      'createdAt',
      'enqueuedAt',
      'entityRefs',
      'input',
      'kind',
      'operation',
      'sessionKey',
      'storeName',
      'storeType',
      'updatedAt',
    ]),
    lastReplayError: resolution.lastReplayError,
  }).toMatchInlineSnapshot(`
    blockedByResolutionIds: []
    blockedResolutionCount: 0
    childResolutionCount: 0
    childResolutionIds: []
    createdAt: 1735689620000
    enqueuedAt: 1735689600000
    entityRefs:
      - { entityKey: 'document', entityKind: 'document' }
    input: { value: 2 }
    kind: 'retry-exhausted'
    lastReplayError: { message: 'replay failed' }
    operation: 'updateValue'
    sessionKey: 'retry-resolution-actions-session'
    storeName: 'document-5'
    storeType: 'document'
    updatedAt: 1735689620000
  `);
  await env.apiStore.resolveOfflineResolution(resolution.id, 'updateValue', {
    action: 'retry',
  });
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689620000
      entityKey: 'document'
      entityKind: 'document'
      id: 'retry-resolution-actions-session:document-5:document'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'retry-resolution-actions-session'
      storeName: 'document-5'
      storeType: 'document'
      syncState: 'pending'
      updatedAt: 1735689620000
  `);

  await waitForMicrotaskCondition(() => execute.mock.calls.length === 6);
  await flushAllTimers();
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);

  act(() => {
    network.goOffline();
  });
  await Promise.resolve();
  await queueOfflineMutation();
  act(() => {
    network.goOnline();
  });
  await waitForMicrotaskCondition(() => execute.mock.calls.length === 7);
  for (const attempt of [8, 9, 10, 11]) {
    await advanceTime(5_000);
    await waitForMicrotaskCondition(
      () => execute.mock.calls.length === attempt,
    );
  }
  await flushAllTimers();

  const [discardResolution] = env.apiStore.getOfflineResolutions();
  if (!discardResolution || discardResolution.kind !== 'retry-exhausted') {
    throw new Error('Expected a retry-exhausted discard resolution');
  }

  expect({
    ...pick(discardResolution, [
      'blockedByResolutionIds',
      'blockedResolutionCount',
      'childResolutionCount',
      'childResolutionIds',
      'createdAt',
      'enqueuedAt',
      'entityRefs',
      'input',
      'kind',
      'operation',
      'sessionKey',
      'storeName',
      'storeType',
      'updatedAt',
    ]),
    lastReplayError: discardResolution.lastReplayError,
  }).toMatchInlineSnapshot(`
    blockedByResolutionIds: []
    blockedResolutionCount: 0
    childResolutionCount: 0
    childResolutionIds: []
    createdAt: 1735689640000
    enqueuedAt: 1735689620000
    entityRefs:
      - { entityKey: 'document', entityKind: 'document' }
    input: { value: 2 }
    kind: 'retry-exhausted'
    lastReplayError: { message: 'replay failed' }
    operation: 'updateValue'
    sessionKey: 'retry-resolution-actions-session'
    storeName: 'document-5'
    storeType: 'document'
    updatedAt: 1735689640000
  `);
  await env.apiStore.resolveOfflineResolution(
    discardResolution.id,
    'updateValue',
    { action: 'discard' },
  );

  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
});

test('outage-classified replay failures do not count toward retry exhaustion', async () => {
  network.setOffline();
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockRejectedValueOnce(new Error('outage'))
    .mockRejectedValueOnce(new Error('healthy failure'))
    .mockResolvedValue({ value: 2 });
  const recoveryCheck = vi
    .fn<({ sessionKey }: { sessionKey: string }) => boolean>()
    .mockReturnValue(true);

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'retry-outage-session',
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () => 'retry-outage-session',
          config: {
            network: { enabled: true },
            classifyFailure: (error, ctx) =>
              ctx.phase === 'sync' &&
              error instanceof Error &&
              error.message === 'outage'
                ? 'outage'
                : 'ignore',
            outage: {
              enabled: true,
              recoveryCheck,
              recoveryProbe: {
                initialIntervalMs: 50,
                maxIntervalMs: 50,
                backoffMultiplier: 1,
                jitterRatio: 0,
              },
            },
            replayRetry: { maxFailures: 2 },
          },
        }),
        operations: {
          updateValue: { inputSchema: docMutationInputSchema, execute },
        },
      },
    },
  });

  await env.apiStore.performMutation({
    mutation: () => Promise.resolve(2),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  act(() => {
    network.goOnline();
  });
  await advanceTime(60);
  await waitForMicrotaskCondition(() => execute.mock.calls.length === 2);

  expect(recoveryCheck).toHaveBeenCalledTimes(1);
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: 'document'
      entityKind: 'document'
      id: 'retry-outage-session:document-6:document'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'retry-outage-session'
      storeName: 'document-6'
      storeType: 'document'
      syncState: 'needs-confirmation'
      updatedAt: 1735689600050
  `);
});

test('going offline again resets the healthy replay failure budget', async () => {
  network.setOffline();
  let countedFailures = 0;
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockImplementation(() => {
      countedFailures += 1;
      throw new Error(`healthy failure ${countedFailures}`);
    });

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'retry-budget-reset-session',
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () => 'retry-budget-reset-session',
          config: { network: network.config },
        }),
        operations: {
          updateValue: { inputSchema: docMutationInputSchema, execute },
        },
      },
    },
  });

  trackDocumentReplayState(env);

  await env.apiStore.performMutation({
    mutation: () => Promise.resolve(2),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });
  trackDocumentReplayState(env);

  // Start replaying while online, but stop before the queued mutation has
  // exhausted its healthy retry budget.
  env.addTimelineComments('beforeNextAction', [
    'start replaying online, but stop before the queued mutation exhausts its healthy retry budget',
  ]);
  act(() => {
    network.goOnline();
  });
  await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);
  trackDocumentReplayState(env);

  env.addTimelineComments('beforeNextAction', [
    'keep retrying until the mutation has spent only part of its healthy retry budget',
  ]);
  for (const attempt of [2, 3]) {
    await advanceTime(5_000);
    await waitForMicrotaskCondition(
      () => execute.mock.calls.length === attempt,
    );
  }
  trackDocumentReplayState(env);

  // Going offline while the queued mutation is paused in needs-confirmation
  // should let the next online transition restart the healthy retry budget.
  env.addTimelineComments('beforeNextAction', [
    'go offline again while the queued mutation is paused in needs-confirmation',
  ]);
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();
  trackDocumentReplayState(env);

  env.addTimelineComments('beforeNextAction', [
    'come back online and verify the paused mutation gets a fresh healthy retry budget',
  ]);
  act(() => {
    network.goOnline();
  });
  await waitForMicrotaskCondition(() => execute.mock.calls.length === 4);
  trackDocumentReplayState(env);

  env.addTimelineComments('beforeNextAction', [
    'spend the fresh retry budget; only after these new failures should the mutation require resolution',
  ]);
  for (const attempt of [5, 6, 7, 8]) {
    await advanceTime(5_000);
    await waitForMicrotaskCondition(
      () => execute.mock.calls.length === attempt,
    );
  }
  await flushAllTimers();
  trackDocumentReplayState(env);

  expect(
    env.apiStore
      .getOfflineResolutions()
      .map((resolution) => ({
        ...pick(resolution, [
          'blockedByResolutionIds',
          'blockedResolutionCount',
          'childResolutionCount',
          'childResolutionIds',
          'createdAt',
          'enqueuedAt',
          'entityRefs',
          'input',
          'kind',
          'operation',
          'sessionKey',
          'storeName',
          'storeType',
          'updatedAt',
        ]),
        lastReplayError:
          resolution.kind === 'retry-exhausted'
            ? resolution.lastReplayError
            : null,
      })),
  ).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689630000
      enqueuedAt: 1735689600000
      entityRefs:
        - { entityKey: 'document', entityKind: 'document' }
      input: { value: 2 }
      kind: 'retry-exhausted'
      lastReplayError: { message: 'healthy failure 8' }
      operation: 'updateValue'
      sessionKey: 'retry-budget-reset-session'
      storeName: 'document-7'
      storeType: 'document'
      updatedAt: 1735689630000
  `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time | ui                                           |
    0    | "value:1 sync:none pending:0"                | ui-initialized
    .    | "value:1 sync:none pending:0"                | offline:updateValue queued
    .    | "value:1 sync:pending pending:1"             | ui-changed
    .    | "value:1 sync:pending pending:1"             | -- start replaying online, but stop before the queued mutation exhausts its healthy retry budget
    .    | "value:1 sync:pending pending:1"             | offline:updateValue replay-started
    .    | "value:1 sync:syncing pending:1"             | ui-changed
    5s   | "value:1 sync:syncing pending:1"             | -- keep retrying until the mutation has spent only part of its healthy retry budget
    .    | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    10s  | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .    | "value:1 sync:needs-confirmation pending:1"  | ui-changed
    .    | "value:1 sync:needs-confirmation pending:1"  | -- go offline again while the queued mutation is paused in needs-confirmation
    .    | "value:1 sync:needs-confirmation pending:1"  | -- come back online and verify the paused mutation gets a fresh healthy retry budget
    .    | "value:1 sync:needs-confirmation pending:1"  | offline:updateValue replay-started
    .    | "value:1 sync:syncing pending:1"             | ui-changed
    15s  | "value:1 sync:syncing pending:1"             | -- spend the fresh retry budget; only after these new failures should the mutation require resolution
    .    | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    20s  | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    25s  | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    30s  | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .    | "value:1 sync:syncing pending:1"             | offline:updateValue resolution-required
    .    | "value:1 sync:resolution-required pending:0" | ui-changed
    "
  `);
});

test('needs-confirmation entries do not accept new accumulation before shouldSkipSync runs', async () => {
  network.setOffline();
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
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () =>
            'offline-needs-confirmation-accumulation-session',
          config: { network: { enabled: true } },
        }),
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            accumulation: { mergeInput: ({ incomingInput }) => incomingInput },
            execute,
            shouldSkipSync: () => false,
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

  act(() => {
    network.goOnline();
  });
  await advanceTime(1);
  await Promise.resolve();

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: 'document'
      entityKind: 'document'
      id: 'offline-needs-confirmation-accumulation-session:document-8:document'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'offline-needs-confirmation-accumulation-session'
      storeName: 'document-8'
      storeType: 'document'
      syncState: 'needs-confirmation'
      updatedAt: 1735689600000
  `);

  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  await env.apiStore.performMutation({
    mutation: () => Promise.resolve(3),
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: 'document'
      entityKind: 'document'
      id: 'offline-needs-confirmation-accumulation-session:document-8:document'
      pendingMutations: 2
      requiresResolution: '❌'
      sessionKey: 'offline-needs-confirmation-accumulation-session'
      storeName: 'document-8'
      storeType: 'document'
      syncState: 'needs-confirmation'
      updatedAt: 1735689600001
  `);
});

test('same-entity supersede does not prune attempted needs-confirmation entries', async () => {
  network.setOffline();
  const sessionKey = 'offline-needs-confirmation-supersede-session';
  const storeName = 'offline-needs-confirmation-supersede-store';
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockRejectedValueOnce(new Error('dispatch failed after send'))
    .mockResolvedValue({ value: 3 });

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
            supersedes: { scope: 'same-entity' },
            execute,
            shouldSkipSync: () => false,
          },
        },
      },
    },
  });

  // Let the first queued mutation reach needs-confirmation before adding a new one.
  await env.apiStore.performMutation({
    mutation: () => Promise.resolve(2),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  act(() => {
    network.goOnline();
  });
  await advanceTime(1);
  await Promise.resolve();

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: 'document'
      entityKind: 'document'
      id: 'offline-needs-confirmation-supersede-session:offline-needs-confirmation-supersede-store:document'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'offline-needs-confirmation-supersede-session'
      storeName: 'offline-needs-confirmation-supersede-store'
      storeType: 'document'
      syncState: 'needs-confirmation'
      updatedAt: 1735689600000
  `);

  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  // The new superseding entry should not remove the already-attempted one.
  await env.apiStore.performMutation({
    mutation: () => Promise.resolve(3),
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  expect(
    getOfflineQueueEntries(sessionKey, storeName)
      .map((entry) => {
        const data = getOfflineQueueEntryData(entry);

        return {
          input: data.input,
          operation: data.operation,
          queueOrder: data.queueOrder,
          syncState: data.syncState,
        };
      })
      .sort((left, right) => Number(left.queueOrder) - Number(right.queueOrder))
      .map(({ queueOrder: _queueOrder, ...entry }) => entry),
  ).toMatchInlineSnapshot(`
    - input: { value: 2 }
      operation: 'updateValue'
      syncState: 'needs-confirmation'
    - input: { value: 3 }
      operation: 'updateValue'
      syncState: 'pending'
  `);

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: 'document'
      entityKind: 'document'
      id: 'offline-needs-confirmation-supersede-session:offline-needs-confirmation-supersede-store:document'
      pendingMutations: 2
      requiresResolution: '❌'
      sessionKey: 'offline-needs-confirmation-supersede-session'
      storeName: 'offline-needs-confirmation-supersede-store'
      storeType: 'document'
      syncState: 'needs-confirmation'
      updatedAt: 1735689600001
  `);
});

test('needs-confirmation entries keep retrying shouldSkipSync while the session stays online', async () => {
  network.setOffline();
  let skipCheckEnqueuedAt: number | null = null;
  const execute = vi
    .fn<
      ({
        input,
        enqueuedAt,
      }: {
        input: { value: number };
        enqueuedAt: number;
      }) => Promise<{ value: number }>
    >()
    .mockImplementationOnce(({ input, enqueuedAt }) => {
      expect(enqueuedAt).toBe(TEST_INITIAL_TIME);
      throw new Error(`dispatch failed after send ${input.value}`);
    });
  const shouldSkipSync = vi
    .fn<
      ({
        input,
        enqueuedAt,
      }: {
        input: { value: number };
        enqueuedAt: number;
      }) => Promise<boolean>
    >()
    .mockImplementation(({ input, enqueuedAt }) => {
      skipCheckEnqueuedAt = enqueuedAt;
      expect(input.value).toBe(2);
      return Promise.resolve(true);
    });

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'online-needs-confirmation-retry-session',
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () => 'online-needs-confirmation-retry-session',
          config: { network: network.config },
        }),
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            execute,
            shouldSkipSync,
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

  act(() => {
    network.goOnline();
  });
  await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);
  await waitForMicrotaskCondition(
    () =>
      env.apiStore.getOfflineEntities()[0]?.syncState === 'needs-confirmation',
  );
  expect(execute).toHaveBeenCalledTimes(1);
  expect(shouldSkipSync).toHaveBeenCalledTimes(0);

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: 'document'
      entityKind: 'document'
      id: 'online-needs-confirmation-retry-session:document-9:document'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'online-needs-confirmation-retry-session'
      storeName: 'document-9'
      storeType: 'document'
      syncState: 'needs-confirmation'
      updatedAt: 1735689600000
  `);

  await advanceTime(5_000);
  await flushAllTimers();

  expect(shouldSkipSync).toHaveBeenCalledTimes(1);
  expect(skipCheckEnqueuedAt).toBe(TEST_INITIAL_TIME);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
});

test('session switches do not leave replayed queue entries in the old namespace', async () => {
  network.setOffline();
  let sessionKey: string | false = 'replay-session-a';
  let resolveReplay: ((result: { value: number }) => void) | undefined;

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: 'replay-session-switch-doc',
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
            execute: () =>
              new Promise<{ value: number }>((resolve) => {
                resolveReplay = resolve;
              }),
          },
        },
      },
    },
  });

  await env.apiStore.performMutation({
    mutation: () => Promise.resolve(2),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  expect(
    getLocalStorageKeys().filter((key) =>
      key.startsWith('tsdf.replay-session-a.replay-session-switch-doc.oq.'),
    ),
  ).toHaveLength(1);

  act(() => {
    network.goOnline();
  });
  await waitForMicrotaskCondition(() => resolveReplay !== undefined);

  expect(resolveReplay).toBeDefined();
  sessionKey = 'replay-session-b';
  resolveReplay?.({ value: 2 });
  await flushAllTimers();

  expect(
    getLocalStorageKeys().filter((key) =>
      key.startsWith('tsdf.replay-session-a.replay-session-switch-doc.oq.'),
    ),
  ).toMatchInlineSnapshot(`[]`);
});

describe('basic replay lifecycle', () => {
  test('document offline mutations are queued durably and replay when the browser comes back online', async () => {
    network.setOffline();

    const sessionKey = 'offline-doc-session';
    const storeName = 'offline-doc-store';
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
              execute: ({ input }) => {
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

    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
      - blockedByResolutionIds: []
        blockedResolutionCount: 0
        childResolutionCount: 0
        childResolutionIds: []
        createdAt: 1735689600000
        entityKey: 'document'
        entityKind: 'document'
        id: 'offline-doc-session:offline-doc-store:document'
        pendingMutations: 1
        requiresResolution: '❌'
        sessionKey: 'offline-doc-session'
        storeName: 'offline-doc-store'
        storeType: 'document'
        syncState: 'pending'
        updatedAt: 1735689600000
    `);
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
      .     | "value:2 pending:yes" | offline:updateValue queued
      .     | "value:2 pending:yes" | offline:updateValue replay-started
      .     | "value:2 pending:yes" | offline:updateValue replay-finished
      .     | "value:2 pending:no"  | ui-changed
      10ms  | "value:2 pending:no"  | 🔴 >fetch-started
      810ms | "value:2 pending:no"  | 🔴 <fetch-finished (value: 1)
      .     | "value:1 pending:no"  | ui-changed
      "
    `);
    hook.unmount();
  });
});

describe('hybrid fallback integration', () => {
  test('accumulation still merges entries when the queue starts from a fallback', async () => {
    const sessionKey = 'hybrid-accumulation-session';
    const storeName = 'hybrid-accumulation-store';
    const directMutation = vi.fn(() =>
      Promise.reject(new Error('offline-fallback')),
    );
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
            config: {
              network: network.config,
              classifyFailure: (error, ctx) =>
                classifyMutationOutage(error, ctx.phase) ? 'outage' : 'ignore',
              outage: {
                enabled: true,
                recoveryCheck: () => false,
                recoveryProbe: quickRecoveryProbe,
              },
            },
          }),
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              accumulation: {
                mergeInput: ({ incomingInput }) => incomingInput,
              },
              execute: ({ input }) => input,
            },
          },
        },
      },
    });

    // The first mutation becomes a fallback-queued entry. Once the session is
    // in outage mode, the next mutation should merge into that persisted entry.
    await env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: directMutation,
      offline: { operation: 'updateValue', input: { value: 2 } },
    });
    await env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 3;
        });
      },
      mutation: () => Promise.resolve(3),
      offline: { operation: 'updateValue', input: { value: 3 } },
    });

    expect(directMutation).toHaveBeenCalledTimes(1);
    expect(env.store.state.data).toMatchInlineSnapshot(`
      value: 3
    `);
    expect(getOfflineQueueEntries(sessionKey, storeName)).toHaveLength(1);

    expect(
      pick(
        getOfflineQueueEntryData(
          getOfflineQueueEntries(sessionKey, storeName)[0]!,
        ),
        [
          'attempts',
          'createdAt',
          'entityRefs',
          'input',
          'lastAttemptAt',
          'operation',
          'queueOrder',
          'sessionKey',
          'storeName',
          'storeType',
          'syncState',
          'updatedAt',
        ],
      ),
    ).toMatchInlineSnapshot(`
      attempts: 0
      createdAt: 1735689600000
      entityRefs:
        - { entityKey: 'document', entityKind: 'document' }
      input: { value: 3 }
      lastAttemptAt: null
      operation: 'updateValue'
      queueOrder: 1735689600000
      sessionKey: 'hybrid-accumulation-session'
      storeName: 'hybrid-accumulation-store'
      storeType: 'document'
      syncState: 'pending'
      updatedAt: 1735689600000
    `);
  });

  test('mutations queued via hybrid fallback enter the resolution queue after replay retries are exhausted', async () => {
    const execute = vi
      .fn<
        ({ input }: { input: { value: number } }) => Promise<{ value: number }>
      >()
      .mockRejectedValue(new Error('replay failed'));
    const env = createDocumentStoreTestEnv<
      number,
      UpdateValueConflictOperations
    >(1, {
      getSessionKey: () => 'hybrid-retry-exhaustion-session',
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => 'hybrid-retry-exhaustion-session',
            config: {
              network: network.config,
              classifyFailure: (error, ctx) =>
                classifyMutationOutage(error, ctx.phase) ? 'outage' : 'ignore',
              outage: {
                enabled: true,
                recoveryCheck: () => true,
                recoveryProbe: quickRecoveryProbe,
              },
              replayRetry: { maxFailures: 2, intervalMs: 1 },
            },
          }),
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              execute,
              conflictHandling: { detectConflict: () => false },
            },
          },
        },
      },
    });

    const result = await env.apiStore.performMutation({
      mutation: () => Promise.reject(new Error('offline-fallback')),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    expect({ ok: result.ok, value: result.ok ? result.value : null })
      .toMatchInlineSnapshot(`
        ok: '✅'
        value: { kind: 'queued' }
      `);

    await advanceTime(1);
    await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);

    await advanceTime(1);
    await waitForMicrotaskCondition(
      () => env.apiStore.getOfflineResolutions().length === 1,
    );

    expect(
      env.apiStore
        .getOfflineResolutions()
        .map((resolution) => ({
          ...pick(resolution, [
            'blockedByResolutionIds',
            'blockedResolutionCount',
            'childResolutionCount',
            'childResolutionIds',
            'createdAt',
            'enqueuedAt',
            'entityRefs',
            'input',
            'kind',
            'operation',
            'sessionKey',
            'storeName',
            'storeType',
            'updatedAt',
          ]),
          lastReplayError:
            resolution.kind === 'retry-exhausted'
              ? resolution.lastReplayError
              : null,
        })),
    ).toMatchInlineSnapshot(`
      - blockedByResolutionIds: []
        blockedResolutionCount: 0
        childResolutionCount: 0
        childResolutionIds: []
        createdAt: 1735689600002
        enqueuedAt: 1735689600000
        entityRefs:
          - { entityKey: 'document', entityKind: 'document' }
        input: { value: 2 }
        kind: 'retry-exhausted'
        lastReplayError: { message: 'replay failed' }
        operation: 'updateValue'
        sessionKey: 'hybrid-retry-exhaustion-session'
        storeName: 'document-10'
        storeType: 'document'
        updatedAt: 1735689600002
    `);
  });
});
