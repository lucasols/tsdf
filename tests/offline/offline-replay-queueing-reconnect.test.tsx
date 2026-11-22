import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type {
  CollectionOfflineOperationDefinition,
  ListQueryOfflineOperationDefinition,
} from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import { createFocusChangeCoordinator } from '../browser-tabs/browser-tabs-test-helpers';
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
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import { createReplayFailure } from './offlineReplayTestShared';
import {
  classifyMutationOutage,
  classifyRetryableReplayFailure,
  collectionCreateInputSchema,
  collectionSchema,
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

test('a list query change waiting for a decision only holds back its own row: the other replayed rows and the lists are revalidated after recovering', async () => {
  network.setOffline();
  const sessionKey = 'recovery-revalidation-list-session';

  type RenameUserOperations = {
    renameUser: ListQueryOfflineOperationDefinition<
      { id: number; name: string },
      ListQueryParams,
      string,
      { itemId: string; name: string },
      { reason: string }
    >;
  };

  // The server computes part of what it saves (like an updated-at field): it
  // stores the sent name with a ` (saved)` suffix, which only a revalidation
  // brings to the client. Someone else renames Ada while we are offline, so
  // our rename of her conflicts and waits for the user to decide on it.
  const env = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    RenameUserOperations
  >(
    {
      users: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
    },
    {
      id: 'recovery-revalidation-list-store',
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
            renameUser: {
              inputSchema: userPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              conflictHandling: {
                schema: rc_object({ reason: rc_string }),
                detectConflict: ({ input }) =>
                  input.itemId === 'users||1'
                    ? { reason: 'renamed by someone else' }
                    : null,
              },
              execute: async ({ input }) => {
                await env.serverTable.delayedUpdateItem(input.itemId, {
                  name: `${input.name} (saved)`,
                });
              },
              // The app keeps the optimistic values: the revalidation after
              // the replay brings what the server saved.
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
    // Screens that show each user on their own (e.g. a detail panel)
    const ada = env.apiStore.useItem('users||1');
    const grace = env.apiStore.useItem('users||2');
    env.trackItemUI('rows', query.items.join(', '));
    env.trackItemUI('ada', ada.data?.name ?? `- ${ada.status}`);
    env.trackItemUI('grace', grace.data?.name ?? `- ${grace.status}`);
  });
  await flushAllTimers();

  // Offline: rename both users. Meanwhile someone else renames Ada.
  env.addTimelineComments('beforeNextAction', [
    'offline: rename Ada and Grace',
  ]);
  for (const [itemId, name] of [
    ['users||1', 'Ada edited'],
    ['users||2', 'Grace edited'],
  ] as const) {
    await act(async () => {
      await env.apiStore.performMutation(itemId, {
        optimisticUpdate: () => {
          env.apiStore.updateItemState(itemId, (item) => ({ ...item, name }));
        },
        mutation: () => Promise.reject(new Error('unreachable while offline')),
        offline: { operation: 'renameUser', input: { itemId, name } },
      });
    });
  }
  env.serverTable.updateItem('users||1', { name: 'Ada by Bob' });
  env.serverTable.clearFetchHistory();

  // Back online: Ada's rename waits for a decision and Grace's is saved. The
  // store revalidates once the queue is drained, leaving out only Ada: her
  // item is not refetched, and the refetched list keeps her local rename
  // instead of Bob's, since the user still has to decide on it. Grace's row
  // and item show what the server saved.
  env.addTimelineComments('beforeNextAction', [
    'back online: Ada conflicts, Grace is saved, then all but Ada is revalidated',
  ]);
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  // One list fetch and one item fetch, for Grace only
  expect(env.serverTable.getRequestHistory('all', { includeTime: false }))
    .toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 2
      - _type: 'item'
        payload: { itemId: 'users||2' }
    `);

  // The user keeps their rename of Ada: the app saves it through its own API,
  // then marks the conflict as handled. Only then is Ada revalidated, which
  // brings what the server saved for her. With nothing left waiting for a
  // decision, the store revalidates everything, like any recovery.
  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution) throw new Error('Expected Ada to wait for a decision');
  env.serverTable.updateItem('users||1', { name: 'Ada edited (saved)' });
  env.addTimelineComments('beforeNextAction', [
    'the user keeps their rename of Ada: Ada and the list are revalidated',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(resolution.id, 'renameUser', {
      action: 'commit',
    });
  });
  await flushAllTimers();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ada                | grace                | rows                                     |
    0     | Ada                | Grace                | Ada, Grace                               | [rows, ada, grace] ui-initialized
    3.01s | Ada                | Grace                | Ada, Grace                               | -- offline: rename Ada and Grace
    .     | Ada edited         | Grace                | Ada edited, Grace                        | [rows, ada] ui-changed
    .     | Ada edited         | Grace                | Ada edited, Grace                        | offline:renameUser queued
    .     | Ada edited         | Grace edited         | Ada edited, Grace edited                 | [rows, grace] ui-changed
    .     | Ada edited         | Grace edited         | Ada edited, Grace edited                 | offline:renameUser queued
    .     | Ada edited         | Grace edited         | Ada edited, Grace edited                 | [users||1] server-data-changed (value: {"name":"Ada by Bob"})
    .     | Ada edited         | Grace edited         | Ada edited, Grace edited                 | -- back online: Ada conflicts, Grace is saved, then all but Ada is revalidated
    .     | Ada edited         | Grace edited         | Ada edited, Grace edited                 | offline:renameUser resolution-required
    .     | Ada edited         | Grace edited         | Ada edited, Grace edited                 | offline:renameUser replay-started
    4.21s | Ada edited         | Grace edited         | Ada edited, Grace edited                 | [users||2] server-data-changed (value: {"name":"Grace edited (saved)"})
    .     | Ada edited         | Grace edited         | Ada edited, Grace edited                 | offline:renameUser replay-finished
    4.22s | Ada edited         | Grace edited         | Ada edited, Grace edited                 | 🔴 >list-fetch-started
    .     | Ada edited         | Grace edited         | Ada edited, Grace edited                 | 🟠 [users||2] >fetch-started
    5.02s | Ada edited         | Grace edited         | Ada edited, Grace edited                 | 🔴 <list-fetch-finished (value: {"count":2})
    .     | Ada edited         | Grace edited (saved) | Ada edited, Grace edited (saved)         | [rows, grace] ui-changed
    .     | Ada edited         | Grace edited (saved) | Ada edited, Grace edited (saved)         | 🟠 [users||2] <fetch-finished (value: {"id":2,"name":"Grace edited (saved)"})
    6.02s | Ada edited         | Grace edited (saved) | Ada edited, Grace edited (saved)         | [users||1] server-data-changed (value: {"name":"Ada edited (saved)"})
    6.03s | Ada edited         | Grace edited (saved) | Ada edited, Grace edited (saved)         | -- the user keeps their rename of Ada: Ada and the list are revalidated
    .     | Ada edited         | Grace edited (saved) | Ada edited, Grace edited (saved)         | 🟡 >list-fetch-started
    .     | Ada edited         | Grace edited (saved) | Ada edited, Grace edited (saved)         | 🟢 [users||1] >fetch-started
    .     | Ada edited         | Grace edited (saved) | Ada edited, Grace edited (saved)         | 🔵 [users||2] >fetch-started
    6.83s | Ada edited         | Grace edited (saved) | Ada edited, Grace edited (saved)         | 🟡 <list-fetch-finished (value: {"count":2})
    .     | Ada edited (saved) | Grace edited (saved) | Ada edited (saved), Grace edited (saved) | [rows, ada] ui-changed
    .     | Ada edited (saved) | Grace edited (saved) | Ada edited (saved), Grace edited (saved) | 🟢 [users||1] <fetch-finished (value: {"id":1,"name":"Ada edited (saved)"})
    .     | Ada edited (saved) | Grace edited (saved) | Ada edited (saved), Grace edited (saved) | 🔵 [users||2] <fetch-finished (value: {"id":2,"name":"Grace edited (saved)"})
    "
  `);

  hook.unmount();
});

test('a row moved between lists by a change waiting for a decision stays where it was moved until the change is handled', async () => {
  network.setOffline();
  const sessionKey = 'recovery-revalidation-moved-row-session';
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  type UserRow = { id: number; name: string; type: string };

  type ChangeTypeOperations = {
    changeType: ListQueryOfflineOperationDefinition<
      UserRow,
      ListQueryParams,
      string,
      { itemId: string; type: string },
      { reason: string }
    >;
  };

  const adminsQuery: ListQueryParams = {
    tableId: 'users',
    filters: [{ op: 'eq', field: 'type', value: 'admin' }],
  };
  const regularUsersQuery: ListQueryParams = {
    tableId: 'users',
    filters: [{ op: 'eq', field: 'type', value: 'user' }],
  };

  // Someone else renames Ada while we are offline, so our change of her type
  // conflicts and waits for the user to decide on it.
  const env = createListQueryStoreTestEnv<
    UserRow,
    false,
    false,
    ChangeTypeOperations
  >(
    {
      users: [
        { id: 1, name: 'Ada', type: 'admin' },
        { id: 2, name: 'Grace', type: 'admin' },
        { id: 3, name: 'Linus', type: 'user' },
      ],
    },
    {
      id: 'recovery-revalidation-moved-row-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      testScenario: { loaded: { queries: [adminsQuery, regularUsersQuery] } },
      revalidateOnWindowFocus: true,
      bindFocusController: tabs.bind('a'),
      // A row changing type moves between the admins and users lists
      optimisticListUpdates: [
        {
          queries: (query) => query.tableId === 'users',
          filterItem: (user, { queryPayload }) =>
            queryPayload.filters?.some(
              (filter) => filter.op === 'eq' && filter.value === user.type,
            ) ?? null,
        },
      ],
      persistentStorage: {
        adapter: 'local-sync',
        schema: rc_object({ id: rc_number, name: rc_string, type: rc_string }),
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          operations: {
            changeType: {
              inputSchema: rc_object({ itemId: rc_string, type: rc_string }),
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              conflictHandling: {
                schema: rc_object({ reason: rc_string }),
                detectConflict: () => ({ reason: 'renamed by someone else' }),
              },
              // Never runs: the change always conflicts
              execute: async () => {},
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const admins = env.apiStore.useListQuery(adminsQuery, {
      itemSelector: (item) => item.name,
    });
    const regularUsers = env.apiStore.useListQuery(regularUsersQuery, {
      itemSelector: (item) => item.name,
    });
    // A detail panel showing Ada
    const ada = env.apiStore.useItem('users||1');
    env.trackItemUI('admins', admins.items.join(', '));
    env.trackItemUI('users', regularUsers.items.join(', '));
    env.trackItemUI(
      'ada',
      ada.data ? `${ada.data.name}:${ada.data.type}` : '-',
    );
  });
  await flushAllTimers();

  // Offline: make Ada a regular user, which moves her to the users list.
  // Meanwhile someone else renames her.
  env.addTimelineComments('beforeNextAction', ['offline: Ada becomes a user']);
  await act(async () => {
    await env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', (item) => ({
          ...item,
          type: 'user',
        }));
      },
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: {
        operation: 'changeType',
        input: { itemId: 'users||1', type: 'user' },
      },
    });
  });
  env.serverTable.updateItem('users||1', { name: 'Ada by Bob' });

  // Back online: the change conflicts. Both lists are refetched, but the
  // server still lists Ada as an admin: she stays where the change moved her,
  // in the users list only.
  env.addTimelineComments('beforeNextAction', [
    'back online: the change conflicts, the lists are refetched',
  ]);
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  // Coming back to the tab revalidates the lists again, but not Ada: a
  // refetch of her would replace the change the user still has to decide on.
  env.addTimelineComments('beforeNextAction', [
    'the user comes back to the tab: the lists are refetched, Ada is not',
  ]);
  await tabs.blur();
  await tabs.focusTab('a');
  await flushAllTimers();

  // The user drops the change: Ada and the lists are refetched, which moves
  // her back to the admins list, with Bob's rename.
  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution) throw new Error('Expected Ada to wait for a decision');
  env.addTimelineComments('beforeNextAction', [
    'the user discards the change: Ada goes back to the admins',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(resolution.id, 'changeType', {
      action: 'discard',
    });
  });
  await flushAllTimers();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ada              | admins            | users             |
    0      | Ada:admin        | Ada, Grace        | Linus             | [admins, users, ada] ui-initialized
    3.01s  | Ada:admin        | Ada, Grace        | Linus             | -- offline: Ada becomes a user
    .      | Ada:user         | Grace             | Linus, Ada        | [admins, users, ada] ui-changed
    .      | Ada:user         | Grace             | Linus, Ada        | offline:changeType queued
    .      | Ada:user         | Grace             | Linus, Ada        | [users||1] server-data-changed (value: {"name":"Ada by Bob"})
    .      | Ada:user         | Grace             | Linus, Ada        | -- back online: the change conflicts, the lists are refetched
    .      | Ada:user         | Grace             | Linus, Ada        | offline:changeType resolution-required
    3.02s  | Ada:user         | Grace             | Linus, Ada        | 🔴 >list-fetch-started
    .      | Ada:user         | Grace             | Linus, Ada        | 🟠 >list-fetch-started
    3.82s  | Ada:user         | Grace             | Linus, Ada        | 🔴 <list-fetch-finished (value: {"count":2})
    .      | Ada:user         | Grace             | Linus, Ada        | 🟠 <list-fetch-finished (value: {"count":1})
    4.82s  | Ada:user         | Grace             | Linus, Ada        | -- the user comes back to the tab: the lists are refetched, Ada is not
    .      | Ada:user         | Grace             | Linus, Ada        | 🔕 window-blurred
    4.825s | Ada:user         | Grace             | Linus, Ada        | 👁 window-focused
    4.835s | Ada:user         | Grace             | Linus, Ada        | 🟡 >list-fetch-started
    .      | Ada:user         | Grace             | Linus, Ada        | 🟢 >list-fetch-started
    5.635s | Ada:user         | Grace             | Linus, Ada        | 🟡 <list-fetch-finished (value: {"count":2})
    .      | Ada:user         | Grace             | Linus, Ada        | 🟢 <list-fetch-finished (value: {"count":1})
    6.645s | Ada:user         | Grace             | Linus, Ada        | -- the user discards the change: Ada goes back to the admins
    .      | Ada:user         | Grace             | Linus, Ada        | 🔵 >list-fetch-started
    .      | Ada:user         | Grace             | Linus, Ada        | 🟣 >list-fetch-started
    .      | Ada:user         | Grace             | Linus, Ada        | 🟤 [users||1] >fetch-started
    7.445s | Ada:user         | Grace             | Linus, Ada        | 🔵 <list-fetch-finished (value: {"count":2})
    .      | Ada by Bob:admin | Ada by Bob, Grace | Linus, Ada by Bob | [admins, users, ada] ui-changed
    .      | Ada by Bob:admin | Ada by Bob, Grace | Linus, Ada by Bob | 🟣 <list-fetch-finished (value: {"count":1})
    .      | Ada by Bob:admin | Ada by Bob, Grace | Linus             | [users] ui-changed
    .      | Ada by Bob:admin | Ada by Bob, Grace | Linus             | 🟤 [users||1] <fetch-finished (value: {"id":1,"name":"Ada by Bob","type":"admin"})
    "
  `);

  hook.unmount();
});

test('a document change waiting for a decision is not replaced by window-focus revalidations', async () => {
  network.setOffline();
  const sessionKey = 'recovery-revalidation-document-focus-session';
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createDocumentStoreTestEnv<number, UpdateValueConflictOperations>(
    1,
    {
      id: 'recovery-revalidation-document-focus-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      testScenario: 'loaded',
      revalidateOnWindowFocus: true,
      bindFocusController: tabs.bind('a'),
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              kind: 'update',
              // Never runs: the change always conflicts
              execute: () => Promise.resolve(),
              onSuccessExecute: () => {},
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: () => ({ reason: 'server-changed' }),
              },
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const doc = env.apiStore.useDocument();
    env.trackUIChanges(`value:${doc.data?.value ?? 'null'}`);
  });
  await flushAllTimers();

  // Offline, the user sets the value to 2. Meanwhile someone else sets it to
  // 5, so the change conflicts and waits for a decision once back online.
  env.addTimelineComments('beforeNextAction', [
    'offline: the value is set to 2',
  ]);
  await act(async () => {
    await env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });
  });
  env.serverMock.setData(5);

  env.addTimelineComments('beforeNextAction', [
    'back online: the change conflicts',
  ]);
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  // Coming back to the tab doesn't refetch the document: the refetch would
  // replace the change the user still has to decide on.
  env.addTimelineComments('beforeNextAction', [
    'the user comes back to the tab: the document is not refetched',
  ]);
  await tabs.blur();
  await tabs.focusTab('a');
  await flushAllTimers();

  // Discarding the change refetches the document, showing the server value
  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution)
    throw new Error('Expected the change to wait for a decision');
  env.addTimelineComments('beforeNextAction', [
    'the user discards the change: the server value is shown',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(resolution.id, 'updateValue', {
      action: 'discard',
    });
  });
  await flushAllTimers();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui        |
    0      | "value:1" | ui-initialized
    1.01s  | "value:1" | -- offline: the value is set to 2
    .      | "value:2" | ui-changed
    .      | "value:2" | offline:updateValue queued
    .      | "value:2" | server-data-changed (value: 5)
    .      | "value:2" | -- back online: the change conflicts
    .      | "value:2" | offline:updateValue resolution-required
    2.01s  | "value:2" | -- the user comes back to the tab: the document is not refetched
    .      | "value:2" | 🔕 window-blurred
    2.015s | "value:2" | 👁 window-focused
    2.03s  | "value:2" | -- the user discards the change: the server value is shown
    .      | "value:2" | 🔴 >fetch-started
    2.83s  | "value:2" | 🔴 <fetch-finished (value: 5)
    .      | "value:5" | ui-changed
    "
  `);

  hook.unmount();
});

test('a row waiting for a decision shows up when loading more of a list brings it in', async () => {
  const sessionKey = 'recovery-revalidation-load-more-session';

  type UserRow = { id: number; name: string };

  type RenameOperations = {
    rename: ListQueryOfflineOperationDefinition<
      UserRow,
      ListQueryParams,
      string,
      { itemId: string; name: string },
      { reason: string }
    >;
  };

  const usersQuery: ListQueryParams = { tableId: 'users' };

  const env = createListQueryStoreTestEnv<
    UserRow,
    false,
    false,
    RenameOperations
  >(
    {
      users: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
        { id: 3, name: 'Linus' },
        { id: 4, name: 'Ken' },
      ],
    },
    {
      id: 'recovery-revalidation-load-more-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      // The list shows two users per page
      defaultQuerySize: 2,
      persistentStorage: {
        adapter: 'local-sync',
        schema: rc_object({ id: rc_number, name: rc_string }),
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          operations: {
            rename: {
              inputSchema: rc_object({ itemId: rc_string, name: rc_string }),
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              conflictHandling: {
                schema: rc_object({ reason: rc_string }),
                detectConflict: () => ({ reason: 'renamed by someone else' }),
              },
              // Never runs: the change always conflicts
              execute: async () => {},
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const users = env.apiStore.useListQuery(usersQuery, {
      itemSelector: (item) => item.name,
    });
    // A detail panel showing Ken, who is not on the list's first page
    const ken = env.apiStore.useItem('users||4');
    env.trackItemUI('users', users.items.join(', '));
    env.trackItemUI('ken', ken.data ? ken.data.name : '-');
  });
  await flushAllTimers();

  // Offline, the user renames Ken from his detail panel. Meanwhile someone
  // else renames him too, so the change conflicts and waits for a decision.
  env.addTimelineComments('beforeNextAction', ['offline: Ken is renamed']);
  act(() => {
    network.goOffline();
  });
  await advanceTime(100);
  await act(async () => {
    await env.apiStore.performMutation('users||4', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||4', (item) => ({
          ...item,
          name: 'Ken local',
        }));
      },
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: {
        operation: 'rename',
        input: { itemId: 'users||4', name: 'Ken local' },
      },
    });
  });
  env.serverTable.updateItem('users||4', { name: 'Ken by Bob' });

  env.addTimelineComments('beforeNextAction', [
    'back online: the rename conflicts',
  ]);
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  // Loading more of the list brings Ken in: he is shown with his local name,
  // where the server lists him, instead of being left out of the list.
  env.addTimelineComments('beforeNextAction', [
    'the user loads more of the list: Ken shows up with his local name',
  ]);
  act(() => {
    env.apiStore.loadMore(usersQuery, 2);
  });
  await flushAllTimers();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ken       | users                        |
    0     | -         |                              | [users, ken] ui-initialized
    10ms  | -         |                              | 🔴 >list-fetch-started
    .     | -         |                              | 🟠 [users||4] >fetch-started
    810ms | -         |                              | 🔴 <list-fetch-finished (value: {"count":2})
    .     | -         | Ada, Grace                   | [users] ui-changed
    .     | -         | Ada, Grace                   | 🟠 [users||4] <fetch-finished (value: {"id":4,"name":"Ken"})
    .     | Ken       | Ada, Grace                   | [ken] ui-changed
    1.91s | Ken       | Ada, Grace                   | -- offline: Ken is renamed
    .     | Ken local | Ada, Grace                   | [ken] ui-changed
    .     | Ken local | Ada, Grace                   | offline:rename queued
    .     | Ken local | Ada, Grace                   | [users||4] server-data-changed (value: {"name":"Ken by Bob"})
    .     | Ken local | Ada, Grace                   | -- back online: the rename conflicts
    .     | Ken local | Ada, Grace                   | offline:rename resolution-required
    1.92s | Ken local | Ada, Grace                   | 🟡 >list-fetch-started
    2.72s | Ken local | Ada, Grace                   | 🟡 <list-fetch-finished (value: {"count":2})
    3.73s | Ken local | Ada, Grace                   | -- the user loads more of the list: Ken shows up with his local name
    .     | Ken local | Ada, Grace                   | 🟢 >list-fetch-started
    4.53s | Ken local | Ada, Grace                   | 🟢 <list-fetch-finished (value: {"count":4})
    .     | Ken local | Ada, Grace, Linus, Ken local | [users] ui-changed
    "
  `);

  hook.unmount();
});

test('a row waiting for a decision shows up when the list is refetched with a larger size that brings it in', async () => {
  const sessionKey = 'recovery-revalidation-larger-size-session';

  type UserRow = { id: number; name: string };

  type RenameOperations = {
    rename: ListQueryOfflineOperationDefinition<
      UserRow,
      ListQueryParams,
      string,
      { itemId: string; name: string },
      { reason: string }
    >;
  };

  const usersQuery: ListQueryParams = { tableId: 'users' };

  const env = createListQueryStoreTestEnv<
    UserRow,
    false,
    false,
    RenameOperations
  >(
    {
      users: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
        { id: 3, name: 'Linus' },
        { id: 4, name: 'Ken' },
      ],
    },
    {
      id: 'recovery-revalidation-larger-size-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      // The list shows two users per page
      defaultQuerySize: 2,
      persistentStorage: {
        adapter: 'local-sync',
        schema: rc_object({ id: rc_number, name: rc_string }),
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          operations: {
            rename: {
              inputSchema: rc_object({ itemId: rc_string, name: rc_string }),
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              conflictHandling: {
                schema: rc_object({ reason: rc_string }),
                detectConflict: () => ({ reason: 'renamed by someone else' }),
              },
              // Never runs: the change always conflicts
              execute: async () => {},
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const users = env.apiStore.useListQuery(usersQuery, {
      itemSelector: (item) => item.name,
    });
    // A detail panel showing Ken, who is not on the list's first page
    const ken = env.apiStore.useItem('users||4');
    env.trackItemUI('users', users.items.join(', '));
    env.trackItemUI('ken', ken.data ? ken.data.name : '-');
  });
  await flushAllTimers();

  // Offline, the user renames Ken from his detail panel. Meanwhile someone
  // else renames him too, so the change conflicts and waits for a decision.
  env.addTimelineComments('beforeNextAction', ['offline: Ken is renamed']);
  act(() => {
    network.goOffline();
  });
  await advanceTime(100);
  await act(async () => {
    await env.apiStore.performMutation('users||4', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||4', (item) => ({
          ...item,
          name: 'Ken local',
        }));
      },
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: {
        operation: 'rename',
        input: { itemId: 'users||4', name: 'Ken local' },
      },
    });
  });
  env.serverTable.updateItem('users||4', { name: 'Ken by Bob' });

  env.addTimelineComments('beforeNextAction', [
    'back online: the rename conflicts',
  ]);
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  // The user switches the list to show four users at once: the refetch with
  // the larger size brings Ken in, and he is shown with his local name where
  // the server lists him, instead of being left out of a list that now
  // reports there is nothing more to load.
  env.addTimelineComments('beforeNextAction', [
    'the list is refetched with four users: Ken shows up with his local name',
  ]);
  act(() => {
    env.apiStore.scheduleListQueryFetch('highPriority', usersQuery, 4);
  });
  await flushAllTimers();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ken       | users                        |
    0     | -         |                              | [users, ken] ui-initialized
    10ms  | -         |                              | 🔴 >list-fetch-started
    .     | -         |                              | 🟠 [users||4] >fetch-started
    810ms | -         |                              | 🔴 <list-fetch-finished (value: {"count":2})
    .     | -         | Ada, Grace                   | [users] ui-changed
    .     | -         | Ada, Grace                   | 🟠 [users||4] <fetch-finished (value: {"id":4,"name":"Ken"})
    .     | Ken       | Ada, Grace                   | [ken] ui-changed
    1.91s | Ken       | Ada, Grace                   | -- offline: Ken is renamed
    .     | Ken local | Ada, Grace                   | [ken] ui-changed
    .     | Ken local | Ada, Grace                   | offline:rename queued
    .     | Ken local | Ada, Grace                   | [users||4] server-data-changed (value: {"name":"Ken by Bob"})
    .     | Ken local | Ada, Grace                   | -- back online: the rename conflicts
    .     | Ken local | Ada, Grace                   | offline:rename resolution-required
    1.92s | Ken local | Ada, Grace                   | 🟡 >list-fetch-started
    2.72s | Ken local | Ada, Grace                   | 🟡 <list-fetch-finished (value: {"count":2})
    3.73s | Ken local | Ada, Grace                   | -- the list is refetched with four users: Ken shows up with his local name
    .     | Ken local | Ada, Grace                   | 🟢 >list-fetch-started
    4.53s | Ken local | Ada, Grace                   | 🟢 <list-fetch-finished (value: {"count":4})
    .     | Ken local | Ada, Grace, Linus, Ken local | [users] ui-changed
    "
  `);

  hook.unmount();
});

test('a collection change waiting for a decision only holds back its own item: the other replayed items are revalidated after recovering', async () => {
  network.setOffline();
  const sessionKey = 'recovery-revalidation-collection-session';

  type RenameItemOperations = {
    renameItem: CollectionOfflineOperationDefinition<
      { value: { name: string } },
      string,
      { itemId: string; name: string }
    >;
  };

  // The server rejects Ada's rename until it is fixed, so the rename ends up
  // waiting for the user to decide on it. It saves Grace's, adding a
  // ` (saved)` suffix that only a revalidation brings to the client.
  let serverRejectsAda = true;
  const env = createCollectionStoreTestEnv<
    { name: string },
    RenameItemOperations
  >(
    { 'users||1': { name: 'Ada' }, 'users||2': { name: 'Grace' } },
    {
      id: 'recovery-revalidation-collection-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
          network: network.config,
          classifyRetryableFailure: (error, ctx) =>
            classifyRetryableReplayFailure(error, ctx.phase),
          replayRetry: { maxFailures: 1, intervalMs: 1 },
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
              inputSchema: userPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: async ({ input }) => {
                if (input.itemId === 'users||1' && serverRejectsAda) {
                  throw new Error('rename rejected');
                }
                await env.serverTable.delayedUpdateItem(input.itemId, {
                  name: `${input.name} (saved)`,
                });
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const ada = env.apiStore.useItem('users||1');
    const grace = env.apiStore.useItem('users||2');
    env.trackItemUI('ada', ada.data?.value.name ?? `- ${ada.status}`);
    env.trackItemUI('grace', grace.data?.value.name ?? `- ${grace.status}`);
  });
  await flushAllTimers();

  // Offline: rename both users.
  env.addTimelineComments('beforeNextAction', [
    'offline: rename Ada and Grace',
  ]);
  for (const [itemId, name] of [
    ['users||1', 'Ada edited'],
    ['users||2', 'Grace edited'],
  ] as const) {
    await act(async () => {
      await env.apiStore.performMutation(itemId, {
        optimisticUpdate: () => {
          env.apiStore.updateItemState(itemId, (draft) => {
            draft.value.name = name;
          });
        },
        mutation: () => Promise.reject(new Error('unreachable while offline')),
        offline: { operation: 'renameItem', input: { itemId, name } },
      });
    });
  }

  // Back online: Ada's rename waits for a decision and Grace's is saved. Once
  // the queue is drained only Grace is refetched: a refetch of Ada would
  // replace the rename the user still has to decide on.
  env.addTimelineComments('beforeNextAction', [
    'back online: Ada needs a decision, Grace is saved and refetched',
  ]);
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  // Once the server is fixed, the user sends Ada's rename again: it is saved,
  // and only now is Ada refetched.
  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution) throw new Error('Expected Ada to wait for a decision');
  serverRejectsAda = false;
  env.addTimelineComments('beforeNextAction', [
    'the user sends the rename of Ada again: it is saved, then Ada is refetched',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(resolution.id, 'renameItem', {
      action: 'retry',
    });
  });
  await flushAllTimers();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ada                | grace                |
    0     | Ada                | Grace                | [ada, grace] ui-initialized
    1.01s | Ada                | Grace                | -- offline: rename Ada and Grace
    .     | Ada edited         | Grace                | [ada] ui-changed
    .     | Ada edited         | Grace                | offline:renameItem queued
    .     | Ada edited         | Grace edited         | [grace] ui-changed
    .     | Ada edited         | Grace edited         | offline:renameItem queued
    .     | Ada edited         | Grace edited         | -- back online: Ada needs a decision, Grace is saved and refetched
    .     | Ada edited         | Grace edited         | offline:renameItem replay-started
    .     | Ada edited         | Grace edited         | offline:renameItem resolution-required
    .     | Ada edited         | Grace edited         | offline:renameItem replay-started
    2.21s | Ada edited         | Grace edited         | [users||2] server-data-changed (value: {"name":"Grace edited (saved)"})
    .     | Ada edited         | Grace edited         | offline:renameItem replay-finished
    2.22s | Ada edited         | Grace edited         | 🔴 [users||2] >fetch-started
    3.02s | Ada edited         | Grace edited         | 🔴 [users||2] <fetch-finished (value: {"name":"Grace edited (saved)"})
    .     | Ada edited         | Grace edited (saved) | [grace] ui-changed
    4.02s | Ada edited         | Grace edited (saved) | -- the user sends the rename of Ada again: it is saved, then Ada is refetched
    .     | Ada edited         | Grace edited (saved) | offline:renameItem replay-started
    5.22s | Ada edited         | Grace edited (saved) | [users||1] server-data-changed (value: {"name":"Ada edited (saved)"})
    .     | Ada edited         | Grace edited (saved) | offline:renameItem replay-finished
    5.23s | Ada edited         | Grace edited (saved) | 🟠 [users||1] >fetch-started
    .     | Ada edited         | Grace edited (saved) | 🟡 [users||2] >fetch-started
    6.03s | Ada edited         | Grace edited (saved) | 🟠 [users||1] <fetch-finished (value: {"name":"Ada edited (saved)"})
    .     | Ada edited (saved) | Grace edited (saved) | [ada] ui-changed
    .     | Ada edited (saved) | Grace edited (saved) | 🟡 [users||2] <fetch-finished (value: {"name":"Grace edited (saved)"})
    "
  `);

  hook.unmount();
});
