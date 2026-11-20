import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type {
  CollectionOfflineOperationDefinition,
  ListQueryOfflineOperationDefinition,
} from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import {
  deleteItemInputSchema,
  getLocalStorageKeys,
  getOfflineQueueEntries,
  getOfflineQueueEntryData,
  type UpdateValueConflictOperations,
  type UpdateValueOperations,
  userRowSchema,
} from './offlineReplayTestShared';
import { createReplayFailure } from './offlineReplayTestShared';
import {
  classifyMutationOutage,
  classifyRetryableReplayFailure,
  collectionCreateInputSchema,
  docConflictSchema,
  docMutationInputSchema,
  docSchema,
  listQueryQueryPayloadSchema,
  quickRecoveryProbe,
  summarizeResolution,
  waitForMicrotaskCondition,
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

test('session switches do not leave replayed queue entries in the old namespace', async () => {
  network.setOffline();
  let sessionKey: string | false = 'replay-session-a';
  let resolveReplay: ((result: { value: number }) => void) | undefined;

  // Use a manually-resolved execute so we can switch the session key while
  // replay is in-flight and verify cleanup happens in the original namespace.
  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: 'replay-session-switch-doc',
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
            execute: () =>
              new Promise<{ value: number }>((resolve) => {
                resolveReplay = (result) => {
                  void env.serverMock.delayedSetData(result.value).then(() => {
                    resolve(result);
                  });
                };
              }),
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

  // Queue a mutation under session-a.
  await env.apiStore.performMutation({
    mutation: async () => {
      await env.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  // Verify the queue entry was persisted under session-a's namespace.
  expect(
    getLocalStorageKeys().filter((key) =>
      key.startsWith('tsdf.replay-session-a.replay-session-switch-doc.oq.'),
    ),
  ).toHaveLength(1);

  // Go online to start replay, but don't resolve yet.
  act(() => {
    network.goOnline();
  });
  await waitForMicrotaskCondition(() => resolveReplay !== undefined);

  // Switch to a new session while replay is in-flight, then resolve.
  // The completed entry should be cleaned from session-a's namespace.
  expect(resolveReplay).toBeDefined();
  sessionKey = 'replay-session-b';
  resolveReplay?.({ value: 2 });
  await flushAllTimers();

  // No leftover queue entries in the old session namespace.
  expect(
    getLocalStorageKeys().filter((key) =>
      key.startsWith('tsdf.replay-session-a.replay-session-switch-doc.oq.'),
    ),
  ).toMatchInlineSnapshot(`[]`);
});

test('document offline mutations are queued durably and replay when the browser comes back online', async () => {
  network.setOffline();

  const sessionKey = 'offline-doc-session';
  const storeName = 'offline-doc-store';
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
      mutation: async () => {
        await env.serverMock.delayedSetData(2);
        return 2;
      },
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
      kind: 'update'
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

  // Once connectivity returns, replay should clear the queue and then
  // revalidate from the server, settling back onto confirmed server data.
  env.addTimelineComments('beforeNextAction', [
    'browser comes back online — replay starts and a revalidation fetch follows',
  ]);
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
    data: { value: 2 }
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
    .     | "value:2 pending:yes" | -- browser comes back online — replay starts and a revalidation fetch follows
    .     | "value:2 pending:yes" | offline:updateValue replay-started
    10ms  | "value:2 pending:yes" | 🔴 >fetch-started
    810ms | "value:2 pending:yes" | 🔴 <fetch-finished (value: 1)
    1.2s  | "value:2 pending:yes" | server-data-changed (value: 2)
    .     | "value:2 pending:yes" | offline:updateValue replay-finished
    .     | "value:2 pending:no"  | ui-changed
    1.21s | "value:2 pending:no"  | 🟠 >fetch-started
    2.01s | "value:2 pending:no"  | 🟠 <fetch-finished (value: 2)
    "
  `);
  hook.unmount();
});

test('accumulation still merges entries when the queue starts from a hybrid fallback', async () => {
  const sessionKey = 'hybrid-accumulation-session';
  const storeName = 'hybrid-accumulation-store';
  // Simulates a mutation that fails at the network level (not queued offline
  // preemptively, but falls back to the offline queue after the error).
  const directMutation = vi.fn(() =>
    Promise.reject(new Error('offline-fallback')),
  );
  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: storeName,
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
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
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            accumulation: { mergeInput: ({ incomingInput }) => incomingInput },
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

  // The first mutation attempts a direct send, which fails with an outage
  // error — falling back to the offline queue. The second mutation should
  // merge into that fallback entry via accumulation rather than creating a
  // separate queue entry.
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
    mutation: async () => {
      await env.serverMock.delayedSetData(3);
      return 3;
    },
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  // Only the first mutation attempted a direct send; the second was queued
  // directly because the session is already in outage mode.
  expect(directMutation).toHaveBeenCalledTimes(1);
  expect(env.store.state.data).toMatchInlineSnapshot(`
    value: 3
  `);
  // Accumulation merged both mutations into a single queue entry with the
  // latest input (value: 3).
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
  // Execute always fails, so the replay budget will be exhausted quickly.
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockRejectedValue(createReplayFailure('replay failed'));
  // Low retry budget (maxFailures: 2, intervalMs: 1) so the test completes
  // quickly. recoveryCheck returns true so recovery probes don't block replay.
  const env = createDocumentStoreTestEnv<number, UpdateValueConflictOperations>(
    1,
    {
      getSessionKey: () => 'hybrid-retry-exhaustion-session',
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => 'hybrid-retry-exhaustion-session',
        offlineSession: {
          network: network.config,
          classifyFailure: (error, ctx) =>
            classifyMutationOutage(error, ctx.phase) ? 'outage' : 'ignore',
          classifyRetryableFailure: (error, ctx) =>
            classifyRetryableReplayFailure(error, ctx.phase),
          outage: {
            enabled: true,
            recoveryCheck: () => true,
            recoveryProbe: quickRecoveryProbe,
          },
          // Low retry budget so the test exhausts it quickly.
          replayRetry: { maxFailures: 2, intervalMs: 500 },
        },
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
              execute,
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateState((draft) => {
                  draft.value = input.value;
                });
              },
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: () => false,
              },
            },
          },
        },
      },
    },
  );

  // The direct mutation fails, falling back to the offline queue.
  const result = await env.apiStore.performMutation({
    mutation: () => Promise.reject(new Error('offline-fallback')),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  // Fallback queueing reports success with a "queued" marker.
  expect({ ok: result.ok, value: result.ok ? result.value : null })
    .toMatchInlineSnapshot(`
      ok: '✅'
      value: { kind: 'queued' }
    `);

  // Let replay attempts exhaust the retry budget.
  await advanceTime(500);
  await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);

  await advanceTime(500);
  await waitForMicrotaskCondition(
    () => env.apiStore.getOfflineResolutions().length === 1,
  );

  // The fallback-queued mutation should end up as a retry-exhausted resolution,
  // proving that hybrid fallback entries follow the same retry exhaustion path
  // as preemptively queued entries.
  expect(env.apiStore.getOfflineResolutions().map(summarizeResolution))
    .toMatchInlineSnapshot(`
      - error: 'replay failed'
        input: 'value: 2'
        kind: 'retry-exhausted'
        on: 'document:document'
        op: 'updateValue'
    `);
});

test('an edit made right after reconnecting is sent after the edits still waiting in the offline queue', async () => {
  network.setOffline();

  const sessionKey = 'offline-online-edit-ordering-session';
  const storeName = 'offline-online-edit-ordering-store';
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
              // Replaying over the connection that just came back is slow.
              await env.serverMock.delayedSetData(input.value, {
                durationMs: 3000,
              });
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

  function editValue(value: number) {
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

  const hook = renderHook(() => {
    const doc = env.apiStore.useDocument();
    env.trackUIChanges(
      `value:${doc.data?.value ?? 'null'} pending:${doc.pendingSync ? 'yes' : 'no'}`,
    );
    return doc;
  });
  await Promise.resolve();

  // First edit happens offline, so it waits in the queue.
  env.addTimelineComments('beforeNextAction', ['offline: edit the value to 2']);
  await act(async () => {
    await editValue(2);
  });

  // Back online: the queued edit starts replaying, and the user edits again
  // before that replay reaches the server.
  env.addTimelineComments('beforeNextAction', [
    'back online: the queued edit starts replaying',
  ]);
  act(() => {
    network.goOnline();
  });
  await advanceTime(500);

  env.addTimelineComments('beforeNextAction', [
    'the user edits the value to 3 while the first edit is still replaying',
  ]);
  let secondEdit: ReturnType<typeof editValue> | undefined;
  act(() => {
    secondEdit = editValue(3);
  });
  await flushAllTimers();
  const secondEditResult = await secondEdit;

  // The second edit is not sent on its own (it would reach the server before
  // the older queued edit, which would then overwrite it): it is queued
  // behind the first one, so the server receives 2 and then 3.
  expect(secondEditResult?.ok).toBe(true);
  // The value shown after everything settled comes from the server (the
  // store revalidates once the queue is drained), so it proves the latest
  // edit is the one that won there.
  expect(hook.result.current.data).toMatchInlineSnapshot(`value: 3`);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                    |
    0     | "value:1 pending:no"  | ui-initialized
    .     | "value:1 pending:no"  | -- offline: edit the value to 2
    .     | "value:2 pending:no"  | ui-changed
    .     | "value:2 pending:yes" | ui-changed
    .     | "value:2 pending:yes" | offline:updateValue queued
    .     | "value:2 pending:yes" | -- back online: the queued edit starts replaying
    .     | "value:2 pending:yes" | offline:updateValue replay-started
    10ms  | "value:2 pending:yes" | 🔴 >fetch-started
    500ms | "value:2 pending:yes" | -- the user edits the value to 3 while the first edit is still replaying
    .     | "value:2 pending:yes" | 🔴 <fetch-aborted 🚫
    .     | "value:3 pending:yes" | ui-changed
    .     | "value:3 pending:yes" | offline:updateValue queued
    820ms | "value:3 pending:yes" | 🟠 >fetch-started
    1.62s | "value:3 pending:yes" | 🟠 <fetch-finished (value: 1)
    3s    | "value:3 pending:yes" | server-data-changed (value: 2)
    .     | "value:3 pending:yes" | offline:updateValue replay-finished
    .     | "value:3 pending:yes" | offline:updateValue replay-started
    6s    | "value:3 pending:yes" | server-data-changed (value: 3)
    .     | "value:3 pending:yes" | offline:updateValue replay-finished
    .     | "value:3 pending:no"  | ui-changed
    6.01s | "value:3 pending:no"  | 🟡 >fetch-started
    6.81s | "value:3 pending:no"  | 🟡 <fetch-finished (value: 3)
    "
  `);

  hook.unmount();
});

test('an item created right after reconnecting on top of an offline creation is sent once that creation reached the server', async () => {
  network.setOffline();
  const sessionKey = 'offline-online-dependent-create-session';

  type FolderOperations = {
    createFolder: CollectionOfflineOperationDefinition<
      { value: { name: string; parentId?: string } },
      string,
      { name: string },
      unknown,
      { id: string }
    >;
    createSubfolder: CollectionOfflineOperationDefinition<
      { value: { name: string; parentId?: string } },
      string,
      { name: string; parentId: string },
      unknown,
      { id: string }
    >;
  };

  const folderSchema = rc_object({
    value: rc_object({ name: rc_string, parentId: rc_string.optionalKey() }),
  });

  const env = createCollectionStoreTestEnv<
    { name: string; parentId?: string },
    FolderOperations
  >(
    {},
    {
      id: 'offline-online-dependent-create-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      persistentStorage: {
        adapter: 'local-sync',
        schema: folderSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            createFolder: {
              inputSchema: collectionCreateInputSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              tempEntity: {
                buildPendingEntity: (input) => ({
                  value: { name: input.name },
                }),
                reconcileServerEntity: (result) => ({
                  finalPayload: result.id,
                }),
              },
              execute: async ({ input }) => {
                // Replaying over the connection that just came back is slow.
                await env.serverTable.delayedSetItem(
                  'folders||1',
                  { name: input.name },
                  { durationMs: 3000 },
                );
                return { id: 'folders||1' };
              },
            },
            createSubfolder: {
              inputSchema: rc_object({ name: rc_string, parentId: rc_string }),
              kind: 'create',
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              dependsOn: ({ input }) => [input.parentId],
              tempEntity: {
                buildPendingEntity: (input) => ({
                  value: { name: input.name, parentId: input.parentId },
                }),
                reconcileServerEntity: (result) => ({
                  finalPayload: result.id,
                }),
              },
              execute: async ({ input }) => {
                await env.serverTable.delayedSetItem('folders||2', input);
                return { id: 'folders||2' };
              },
            },
          },
        },
      },
    },
  );

  // Create a folder offline: it only exists locally, under a temp id.
  await act(async () => {
    await env.apiStore.performMutation(null, {
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: { operation: 'createFolder', input: { name: 'Docs' } },
    });
  });

  // Back online: the folder creation starts replaying, and the user creates
  // a subfolder in it before that replay reaches the server.
  act(() => {
    network.goOnline();
  });
  await advanceTime(500);

  const sendSubfolderDirectly = vi.fn(() =>
    Promise.reject(new Error('the parent folder does not exist yet')),
  );
  let subfolderResult:
    | Awaited<ReturnType<typeof env.apiStore.performMutation>>
    | undefined;
  await act(async () => {
    subfolderResult = await env.apiStore.performMutation(null, {
      mutation: sendSubfolderDirectly,
      offline: {
        operation: 'createSubfolder',
        input: { name: 'Invoices', parentId: 'temp:Docs' },
      },
    });
  });
  await flushAllTimers();

  // Sent on its own, the subfolder would reference a folder the server does
  // not have yet: it is queued behind the folder creation instead, and
  // replayed with the folder's server id.
  expect(sendSubfolderDirectly).not.toHaveBeenCalled();
  expect(subfolderResult?.ok).toBe(true);
  expect(env.serverTable.getAll()).toMatchInlineSnapshot(`
    folders||1: { name: 'Docs' }
    folders||2: { name: 'Invoices', parentId: 'folders||1' }
  `);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
});

test('deleting a folder right after reconnecting is sent after the offline subfolder creation that depends on it', async () => {
  network.setOffline();
  const sessionKey = 'offline-online-delete-dependency-session';

  type FolderOperations = {
    createSubfolder: CollectionOfflineOperationDefinition<
      { value: { name: string; parentId?: string } },
      string,
      { name: string; parentId: string },
      unknown,
      { id: string }
    >;
    deleteFolder: CollectionOfflineOperationDefinition<
      { value: { name: string; parentId?: string } },
      string,
      { itemId: string }
    >;
  };

  const folderSchema = rc_object({
    value: rc_object({ name: rc_string, parentId: rc_string.optionalKey() }),
  });

  // The server keeps the order the mutations reach it in.
  const serverOrder: string[] = [];

  const env = createCollectionStoreTestEnv<
    { name: string; parentId?: string },
    FolderOperations
  >(
    { 'folders||1': { name: 'Docs' } },
    {
      id: 'offline-online-delete-dependency-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      persistentStorage: {
        adapter: 'local-sync',
        schema: folderSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            createSubfolder: {
              inputSchema: rc_object({ name: rc_string, parentId: rc_string }),
              kind: 'create',
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              dependsOn: ({ input }) => [input.parentId],
              tempEntity: {
                buildPendingEntity: (input) => ({
                  value: { name: input.name, parentId: input.parentId },
                }),
                reconcileServerEntity: (result) => ({
                  finalPayload: result.id,
                }),
              },
              execute: async ({ input }) => {
                // Replaying over the connection that just came back is slow.
                await env.serverTable.delayedSetItem('folders||2', input, {
                  durationMs: 3000,
                });
                serverOrder.push(`create subfolder ${input.name}`);
                return { id: 'folders||2' };
              },
            },
            deleteFolder: {
              inputSchema: deleteItemInputSchema,
              kind: 'delete',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: ({ input }) => {
                serverOrder.push(`delete ${input.itemId}`);
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.deleteItemState(input.itemId);
              },
            },
          },
        },
      },
    },
  );

  // Offline: create a subfolder inside the existing Docs folder.
  await act(async () => {
    await env.apiStore.performMutation(null, {
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: {
        operation: 'createSubfolder',
        input: { name: 'Invoices', parentId: 'folders||1' },
      },
    });
  });

  // Back online: the subfolder creation starts replaying, and the user
  // deletes the Docs folder before that replay reaches the server.
  act(() => {
    network.goOnline();
  });
  await advanceTime(500);

  const sendDeleteDirectly = vi.fn(() => {
    serverOrder.push('delete folders||1 (sent directly)');
    return Promise.resolve();
  });
  await act(async () => {
    await env.apiStore.performMutation('folders||1', {
      mutation: sendDeleteDirectly,
      offline: { operation: 'deleteFolder', input: { itemId: 'folders||1' } },
    });
  });
  await flushAllTimers();

  // Sent on its own, the delete would reach the server first and the
  // subfolder creation would then fail for a missing parent: it is queued
  // behind the creation instead, keeping the order the user made them.
  expect(sendDeleteDirectly).not.toHaveBeenCalled();
  expect(serverOrder).toMatchInlineSnapshot(
    `['create subfolder Invoices', 'delete folders||1']`,
  );
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
});

test('lists are revalidated after replaying an offline creation that references no entity', async () => {
  network.setOffline();
  const sessionKey = 'offline-entityless-create-session';

  type EntitylessCreateOperations = {
    createUser: ListQueryOfflineOperationDefinition<
      { id: number; name: string },
      ListQueryParams,
      string,
      { name: string },
      unknown
    >;
  };

  // The server assigns the id and the app shows no optimistic row, so the
  // operation references no entity: only the revalidation after the replay
  // can bring the new row into the list.
  const env = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    EntitylessCreateOperations
  >(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      id: 'offline-entityless-create-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
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
              getEntityRefs: () => [],
              execute: async ({ input }) => {
                await env.serverTable.addItemWithAutoGeneratedKey(
                  'users',
                  (id) => ({ id, name: input.name }),
                );
              },
              // Nothing to sync locally: the list revalidation shows the row.
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(
      { tableId: 'users' },
      { itemSelector: (item) => item.name },
    );
    env.trackItemUI('users', query.items.join(', '));
  });
  await flushAllTimers();

  // Create Grace offline: the creation waits in the queue.
  await act(async () => {
    await env.apiStore.performMutation(null, {
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: { operation: 'createUser', input: { name: 'Grace' } },
    });
  });

  // Back online: the list must only be revalidated once the creation reached
  // the server, otherwise it would be fetched without Grace and never again.
  env.addTimelineComments('beforeNextAction', [
    'back online: the creation is replayed, then the list revalidated',
  ]);
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | users      |
    0     | Ada        | [users] ui-initialized
    3.01s | Ada        | offline:createUser queued
    .     | Ada        | -- back online: the creation is replayed, then the list revalidated
    .     | Ada        | offline:createUser replay-started
    .     | Ada        | [users||2] >add-item-started (value: {"id":2,"name":"Grace"})
    3.85s | Ada        | [users||2] <add-item-persisted (value: {"id":2,"name":"Grace"})
    4.21s | Ada        | offline:createUser replay-finished
    4.22s | Ada        | 🔴 >list-fetch-started
    5.02s | Ada        | 🔴 <list-fetch-finished (value: {"count":2})
    .     | Ada, Grace | [users] ui-changed
    "
  `);

  hook.unmount();
});

test('an offline creation that references no entity and waits for a decision delays the list revalidation until it is handled', async () => {
  network.setOffline();
  const sessionKey = 'offline-entityless-conflict-session';

  type EntitylessCreateOperations = {
    createUser: ListQueryOfflineOperationDefinition<
      { id: number; name: string },
      ListQueryParams,
      string,
      { name: string },
      { reason: string }
    >;
  };

  // The server assigns the id, so the operation references no entity. On
  // replay the app detects a conflict, so the creation waits for the user.
  const env = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    EntitylessCreateOperations
  >(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      id: 'offline-entityless-conflict-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
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
              getEntityRefs: () => [],
              execute: async ({ input }) => {
                await env.serverTable.addItemWithAutoGeneratedKey(
                  'users',
                  (id) => ({ id, name: input.name }),
                );
              },
              onSuccessExecute: () => {},
              conflictHandling: {
                schema: rc_object({ reason: rc_string }),
                detectConflict: () => ({ reason: 'needs-review' }),
              },
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(
      { tableId: 'users' },
      { itemSelector: (item) => item.name },
    );
    env.trackItemUI('users', query.items.join(', '));
  });
  await flushAllTimers();

  // Create Grace offline: the creation waits in the queue.
  await act(async () => {
    await env.apiStore.performMutation(null, {
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: { operation: 'createUser', input: { name: 'Grace' } },
    });
  });

  // Back online: the replay stops at the conflict. The store still has a
  // change waiting for a decision, so its list is not revalidated yet.
  env.addTimelineComments('beforeNextAction', [
    'back online: the creation waits for a decision, no list revalidation',
  ]);
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution) throw new Error('Expected a pending resolution');

  // The user handles the conflict through the app's own API, which creates
  // Grace on the server, then commits it: only now the list is revalidated
  // and shows the new row.
  env.serverTable.setItem('users||2', { id: 2, name: 'Grace' });
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(resolution.id, 'createUser', {
      action: 'commit',
    });
  });
  env.addTimelineComments('afterLastAction', [
    'Grace created through the app API, then the resolution was committed',
  ]);
  await flushAllTimers();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | users      |
    0     | Ada        | [users] ui-initialized
    3.01s | Ada        | offline:createUser queued
    .     | Ada        | -- back online: the creation waits for a decision, no list revalidation
    .     | Ada        | offline:createUser resolution-required
    .     | Ada        | [users||2] server-data-changed (value: {"id":2,"name":"Grace"})
    .     | Ada        | -- Grace created through the app API, then the resolution was committed
    3.02s | Ada        | 🔴 >list-fetch-started
    3.82s | Ada        | 🔴 <list-fetch-finished (value: {"count":2})
    .     | Ada, Grace | [users] ui-changed
    "
  `);

  hook.unmount();
});
