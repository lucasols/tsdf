import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { type CollectionOfflineOperationDefinition } from '../../src/main';
import type { OfflineSessionConfig } from '../../src/persistentStorage/offline/types';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import { withSuppressedActError } from '../utils/withSuppressedActError';
import {
  getOfflineQueueEntries,
  getSortedSessionQueueSummary,
  type UpdateValueConflictOperations,
  type UpdateValueExecuteContext,
  type UpdateValueOperations,
  userPatchSchema,
} from './offlineReplayTestShared';
import {
  classifyRetryableReplayFailure,
  collectionSchema,
  docConflictSchema,
  docMutationInputSchema,
  docSchema,
  resolveOfflineResolutionThroughManager,
  summarizeResolution,
  waitForMicrotaskCondition,
} from './offlineTestShared';
import { createManagedOfflineSession } from './offlineTestShared';

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

test('queued mutations from multiple stores in one session share a single global replay order', async () => {
  network.setOffline();
  const sessionKey = 'shared-session-queue-order';
  const { storeManager } = createManagedOfflineSession({
    getSessionKey: () => sessionKey,
    config: { network: network.config },
  });

  function createEnv(storeName: string) {
    const env: ReturnType<
      typeof createDocumentStoreTestEnv<number, UpdateValueOperations>
    > = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
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

    return env;
  }

  const envA = createEnv('shared-session-queue-order-a');
  const envB = createEnv('shared-session-queue-order-b');
  await Promise.resolve();

  // Both stores first observe the same offline transition before they queue
  // durable work into the shared session.
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  // Queue the first store's mutation.
  await envA.apiStore.performMutation({
    optimisticUpdate: () => {
      envA.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: async () => {
      await envA.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  // Advance time so the second store gets a later replay position.
  await advanceTime(50);

  // Queue the second store's mutation afterwards.
  await envB.apiStore.performMutation({
    optimisticUpdate: () => {
      envB.apiStore.updateState((draft) => {
        draft.value = 3;
      });
    },
    mutation: async () => {
      await envB.serverMock.delayedSetData(3);
      return 3;
    },
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  // The persisted session view should read like one queue ordered by enqueue
  // time, even though each store still persists its own namespace entries.
  expect(getSortedSessionQueueSummary(sessionKey)).toMatchInlineSnapshot(`
    - input: { value: 2 }
      operation: 'updateValue'
      storeName: 'shared-session-queue-order-a'
      storeType: 'document'
    - input: { value: 3 }
      operation: 'updateValue'
      storeName: 'shared-session-queue-order-b'
      storeType: 'document'
  `);
});

test('reconnect replays queued mutations from multiple stores one at a time in global enqueue order', async () => {
  network.setOffline();
  const sessionKey = 'shared-session-replay-order';
  const { storeManager } = createManagedOfflineSession({
    getSessionKey: () => sessionKey,
    config: { network: network.config },
  });
  const replayLog: string[] = [];
  let releaseFirstReplay: (() => void) | null = null;

  function createEnv(args: { storeName: string; shouldBlockReplay?: boolean }) {
    const env: ReturnType<
      typeof createDocumentStoreTestEnv<number, UpdateValueOperations>
    > = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: args.storeName,
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
                replayLog.push(`${args.storeName}:start:${input.value}`);

                if (args.shouldBlockReplay) {
                  await new Promise<void>((resolve) => {
                    releaseFirstReplay = resolve;
                  });
                }

                await env.serverMock.delayedSetData(input.value);
                replayLog.push(`${args.storeName}:finish:${input.value}`);
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

    return env;
  }

  const envA = createEnv({
    storeName: 'shared-session-replay-order-a',
    shouldBlockReplay: true,
  });
  const envB = createEnv({ storeName: 'shared-session-replay-order-b' });
  await Promise.resolve();

  // Both stores must observe the same offline session before queueing work.
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  // Queue the earliest replay candidate in the first store.
  envA.addTimelineComments('beforeNextAction', [
    'queue the first store mutation while the session is offline',
  ]);
  await envA.apiStore.performMutation({
    optimisticUpdate: () => {
      envA.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: async () => {
      await envA.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  // Give the second mutation a later queue position so the intended order is
  // unambiguous in both the persisted queue and the replay log.
  await advanceTime(50);

  // Queue the second store's mutation behind the first one.
  envB.addTimelineComments('beforeNextAction', [
    'queue the second store mutation behind the first one',
  ]);
  await envB.apiStore.performMutation({
    optimisticUpdate: () => {
      envB.apiStore.updateState((draft) => {
        draft.value = 3;
      });
    },
    mutation: async () => {
      await envB.serverMock.delayedSetData(3);
      return 3;
    },
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  expect(getSortedSessionQueueSummary(sessionKey)).toMatchInlineSnapshot(`
    - input: { value: 2 }
      operation: 'updateValue'
      storeName: 'shared-session-replay-order-a'
      storeType: 'document'
    - input: { value: 3 }
      operation: 'updateValue'
      storeName: 'shared-session-replay-order-b'
      storeType: 'document'
  `);

  // Reconnect the shared session. The first replay may start, but the second
  // store must stay queued until that earlier work fully completes.
  envA.addTimelineComments('beforeNextAction', [
    'reconnect the session and let the earliest queued mutation start replaying',
  ]);
  envB.addTimelineComments('beforeNextAction', [
    'reconnect the session and wait for the earlier queued mutation to finish first',
  ]);
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await waitForMicrotaskCondition(() => replayLog.length > 0);

  // Before the first replay is released, only the earliest queued mutation
  // should have started.
  expect(replayLog).toMatchInlineSnapshot(`
    ['shared-session-replay-order-a:start:2']
  `);

  // Once the first replay finishes, the second store can take the next turn.
  await act(async () => {
    releaseFirstReplay?.();
    await flushAllTimers();
  });
  await waitForMicrotaskCondition(() => replayLog.length === 4);

  // The replay log should now read like one shared queue drained in order.
  expect(replayLog).toMatchInlineSnapshot(`
    - 'shared-session-replay-order-a:start:2'
    - 'shared-session-replay-order-a:finish:2'
    - 'shared-session-replay-order-b:start:3'
    - 'shared-session-replay-order-b:finish:3'
  `);
  expect(
    getOfflineQueueEntries(sessionKey, 'shared-session-replay-order-a'),
  ).toMatchInlineSnapshot(`[]`);
  expect(
    getOfflineQueueEntries(sessionKey, 'shared-session-replay-order-b'),
  ).toMatchInlineSnapshot(`[]`);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    0     | -- queue the first store mutation while the session is offline
    .     | offline:updateValue queued
    50ms  | -- reconnect the session and let the earliest queued mutation start replaying
    .     | offline:updateValue replay-started
    1.25s | server-data-changed (value: 2)
    .     | offline:updateValue replay-finished
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    50ms  | -- queue the second store mutation behind the first one
    .     | offline:updateValue queued
    1.25s | -- reconnect the session and wait for the earlier queued mutation to finish first
    .     | offline:updateValue replay-started
    2.45s | server-data-changed (value: 3)
    .     | offline:updateValue replay-finished
    "
  `);
});

test('a store initialized while an earlier shared-session replay is already in flight waits for its turn', async () => {
  network.setOffline();
  const sessionKey = 'shared-session-mid-replay-init';
  const replayLog: string[] = [];
  let hasReleaseFirstReplay = false;
  let releaseFirstReplay: () => void = () => {
    throw new Error('Expected the first replay to be waiting for release');
  };

  function createEnv(args: {
    storeName: string;
    testScenario?: 'idle' | 'loaded';
    onExecute?: (input: { value: number }) => Promise<void> | void;
  }) {
    const env: ReturnType<
      typeof createDocumentStoreTestEnv<number, UpdateValueOperations>
    > = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: args.storeName,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      testScenario: args.testScenario ?? 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              kind: 'update',
              execute: async ({ input }: UpdateValueExecuteContext) => {
                replayLog.push(`${args.storeName}:start:${input.value}`);
                await args.onExecute?.(input);
                await env.serverMock.delayedSetData(input.value);
                replayLog.push(`${args.storeName}:finish:${input.value}`);
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

    return env;
  }

  // Seed durable queue entries for both stores before the replaying session
  // exists, matching a real restart with persisted offline work.
  const seededEnvA = createEnv({
    storeName: 'shared-session-mid-replay-init-a',
    testScenario: 'loaded',
  });
  const seededEnvB = createEnv({
    storeName: 'shared-session-mid-replay-init-b',
    testScenario: 'loaded',
  });
  await Promise.resolve();

  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  await seededEnvA.apiStore.performMutation({
    optimisticUpdate: () => {
      seededEnvA.apiStore.updateState((draft) => {
        draft.value = 2;
      });
    },
    mutation: async () => {
      await seededEnvA.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  await advanceTime(50);

  await seededEnvB.apiStore.performMutation({
    optimisticUpdate: () => {
      seededEnvB.apiStore.updateState((draft) => {
        draft.value = 3;
      });
    },
    mutation: async () => {
      await seededEnvB.serverMock.delayedSetData(3);
      return 3;
    },
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  expect(getSortedSessionQueueSummary(sessionKey)).toMatchInlineSnapshot(`
    - input: { value: 2 }
      operation: 'updateValue'
      storeName: 'shared-session-mid-replay-init-a'
      storeType: 'document'
    - input: { value: 3 }
      operation: 'updateValue'
      storeName: 'shared-session-mid-replay-init-b'
      storeType: 'document'
  `);

  // Reboot into a fresh browser session that starts online.
  resetSessionForTests();
  act(() => {
    network.goOnline();
  });

  // Start only the earliest queued store first and block its execute so replay
  // stays in-flight while the later store is initialized.
  const restartedEnvA = createEnv({
    storeName: 'shared-session-mid-replay-init-a',
    testScenario: 'idle',
    onExecute: async () => {
      await new Promise<void>((resolve) => {
        hasReleaseFirstReplay = true;
        releaseFirstReplay = resolve;
      });
    },
  });
  const restartedHookA = renderHook(() =>
    restartedEnvA.apiStore.useDocument({ returnRefetchingStatus: true }),
  );
  restartedEnvA.addTimelineComments('beforeNextAction', [
    'the restarted session boots online and begins replaying the earliest queued store',
  ]);
  await withSuppressedActError(async () => {
    await flushAllTimers();
    await waitForMicrotaskCondition(() => replayLog.length === 1);
  });

  expect(replayLog).toMatchInlineSnapshot(`
    ['shared-session-mid-replay-init-a:start:2']
  `);

  // Initializing the later store mid-replay must not start its queued entry
  // until the earlier replay has fully completed.
  const restartedEnvB = createEnv({
    storeName: 'shared-session-mid-replay-init-b',
    testScenario: 'idle',
  });
  const restartedHookB = renderHook(() =>
    restartedEnvB.apiStore.useDocument({ returnRefetchingStatus: true }),
  );
  restartedEnvB.addTimelineComments('beforeNextAction', [
    'the later store initializes while the first replay is still in flight',
  ]);
  await withSuppressedActError(async () => {
    await flushAllTimers();
    await Promise.resolve();
  });

  expect(replayLog).toMatchInlineSnapshot(`
    ['shared-session-mid-replay-init-a:start:2']
  `);

  // Releasing the first execute is not enough on its own; the second store
  // still has to wait for the first replay to finish writing its server result.
  expect(hasReleaseFirstReplay).toBe(true);
  releaseFirstReplay();
  await Promise.resolve();
  await Promise.resolve();

  expect(replayLog).toMatchInlineSnapshot(`
    ['shared-session-mid-replay-init-a:start:2']
  `);

  await withSuppressedActError(async () => {
    await flushAllTimers();
    await waitForMicrotaskCondition(() => replayLog.length === 4);
  });

  expect(replayLog).toMatchInlineSnapshot(`
    - 'shared-session-mid-replay-init-a:start:2'
    - 'shared-session-mid-replay-init-a:finish:2'
    - 'shared-session-mid-replay-init-b:start:3'
    - 'shared-session-mid-replay-init-b:finish:3'
  `);
  expect(
    getOfflineQueueEntries(sessionKey, 'shared-session-mid-replay-init-a'),
  ).toMatchInlineSnapshot(`[]`);
  expect(
    getOfflineQueueEntries(sessionKey, 'shared-session-mid-replay-init-b'),
  ).toMatchInlineSnapshot(`[]`);
  expect(restartedEnvA.timelineString).toMatchInlineSnapshot(`
    "
    time   |
    10ms   | -- the restarted session boots online and begins replaying the earliest queued store
    .      | 🔴 >fetch-started
    .      | offline:updateValue replay-started
    810ms  | 🔴 <fetch-finished (value: 1)
    15.2s  | server-data-changed (value: 2)
    .      | offline:updateValue replay-finished
    19.41s | 🟠 >fetch-started
    20.21s | 🟠 <fetch-finished (value: 2)
    "
  `);

  expect(restartedEnvB.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    10ms  | -- the later store initializes while the first replay is still in flight
    .     | 🔴 >fetch-started
    810ms | 🔴 <fetch-finished (value: 1)
    3.2s  | offline:updateValue replay-started
    4.4s  | server-data-changed (value: 3)
    .     | offline:updateValue replay-finished
    4.41s | 🟠 >fetch-started
    5.21s | 🟠 <fetch-finished (value: 3)
    "
  `);

  restartedHookA.unmount();
  restartedHookB.unmount();
});

type RenameCollectionUserOperations = {
  renameUser: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { itemId: string; name: string },
    unknown
  >;
};

// An app-wide "sync problems" panel lists every failed offline mutation of the
// session. It only has the store manager, so it must be able to offer Retry /
// Discard without importing each store and mapping `storeName` to it by hand.
test('a session-wide sync problems panel can retry or discard failed mutations from any store through the manager', async () => {
  network.setOffline();
  const sessionKey = 'manager-resolution-actions';
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: {
      network: network.config,
      classifyRetryableFailure: (error, ctx) =>
        classifyRetryableReplayFailure(error, ctx.phase),
      // A single failed replay is enough to require a manual resolution.
      replayRetry: { maxFailures: 1, intervalMs: 1 },
    },
  });

  // Document store: the first replay fails, the replay after "retry" succeeds.
  const updateValueExecute = vi
    .fn<(ctx: UpdateValueExecuteContext) => Promise<{ value: number }>>()
    .mockRejectedValueOnce(new Error('document replay failed'))
    .mockImplementation(async ({ input }) => {
      await docEnv.serverMock.delayedSetData(input.value);
      return input;
    });
  const docEnv = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: 'manager-resolution-actions-doc',
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
            execute: updateValueExecute,
            onSuccessExecute: ({ input }) => {
              docEnv.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
            },
          },
        },
      },
    },
  });

  // Collection store (a different store type on the same manager): every
  // replay fails, so the user ends up discarding the rename.
  const renameUserExecute = vi
    .fn<
      (ctx: {
        input: { itemId: string; name: string };
      }) => Promise<{ value: { name: string } }>
    >()
    .mockRejectedValue(new Error('rename replay failed'));
  const collectionEnv = createCollectionStoreTestEnv<
    { name: string },
    RenameCollectionUserOperations
  >(
    { 'users||1': { name: 'Ada' } },
    {
      id: 'manager-resolution-actions-users',
      getSessionKey: () => sessionKey,
      storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            renameUser: {
              inputSchema: userPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: renameUserExecute,
              onSuccessExecute: ({ input }) => {
                collectionEnv.apiStore.updateItemState(
                  input.itemId,
                  (draft) => {
                    draft.value.name = input.name;
                  },
                );
              },
            },
          },
        },
      },
    },
  );
  await Promise.resolve();

  // The panel renders straight from the manager, with no reference to the
  // stores that own each record.
  const panelRenders = createLoggerStore();
  const panel = renderHook(() => {
    const resolutions = storeManager.useOfflineResolutions();
    panelRenders.add({
      problems: resolutions.map(
        (resolution) =>
          `${resolution.storeName} › ${resolution.operation} (${resolution.kind})`,
      ),
    });
    return resolutions;
  });

  // Each store's own screen keeps rendering its data and sync state, so the
  // timelines show what the user sees after each panel action.
  const docScreen = renderHook(() => {
    const doc = docEnv.apiStore.useDocument();
    const entity = docEnv.apiStore.useOfflineEntities()[0];
    docEnv.trackUIChanges(
      `value:${doc.data?.value ?? 'null'} sync:${entity?.syncState ?? 'none'}`,
    );
  });
  const usersScreen = renderHook(() => {
    const user = collectionEnv.apiStore.useItem('users||1', {
      selector: (item) => item?.value.name ?? null,
    });
    const entity = collectionEnv.apiStore.useOfflineEntities()[0];
    collectionEnv.trackItemUI(
      'user-1',
      `${user.data ?? 'null'} sync:${entity?.syncState ?? 'none'}`,
    );
  });
  await flushAllTimers();

  // Both stores observe the disconnect before they queue work.
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  // --- Setup: queue one mutation per store while offline ---
  await act(async () => {
    await docEnv.apiStore.performMutation({
      optimisticUpdate: () => {
        docEnv.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: async () => {
        await docEnv.serverMock.delayedSetData(2);
        return 2;
      },
      offline: { operation: 'updateValue', input: { value: 2 } },
    });
    await collectionEnv.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        collectionEnv.apiStore.updateItemState('users||1', (draft) => {
          draft.value.name = 'Ada renamed';
        });
      },
      mutation: async () => {
        await collectionEnv.serverTable.delayedUpdateItem('users||1', {
          name: 'Ada renamed',
        });
        return { value: { name: 'Ada renamed' } };
      },
      offline: {
        operation: 'renameUser',
        input: { itemId: 'users||1', name: 'Ada renamed' },
      },
    });
  });

  // --- Setup: reconnect so both replays fail and need manual resolution ---
  panelRenders.addMark('reconnect — both replays fail');
  docEnv.addTimelineComments('beforeNextAction', [
    'reconnect — the replay fails once and requires manual resolution',
  ]);
  collectionEnv.addTimelineComments('beforeNextAction', [
    'reconnect — the replay fails once and requires manual resolution',
  ]);
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
    await flushAllTimers();
    await waitForMicrotaskCondition(() => panel.result.current.length === 2);
  });

  // The panel lists the failed mutation of each store.
  expect(
    panel.result.current.map((resolution) => ({
      store: resolution.storeName,
      ...summarizeResolution(resolution),
    })),
  ).toMatchInlineSnapshot(`
    - error: 'document replay failed'
      input: 'value: 2'
      kind: 'retry-exhausted'
      on: 'document:document'
      op: 'updateValue'
      store: 'manager-resolution-actions-doc'
    - error: 'rename replay failed'
      input: 'itemId: "users||1", name: "Ada renamed"'
      kind: 'retry-exhausted'
      on: 'item:users||1'
      op: 'renameUser'
      store: 'manager-resolution-actions-users'
  `);

  const docResolution = panel.result.current.find(
    (resolution) => resolution.storeName === 'manager-resolution-actions-doc',
  );
  const usersResolution = panel.result.current.find(
    (resolution) => resolution.storeName === 'manager-resolution-actions-users',
  );
  if (!docResolution || !usersResolution) {
    throw new Error('Expected one failed mutation per store');
  }

  // --- Action: "Retry" on the document row, using only the manager ---
  panelRenders.addMark('user clicks Retry on the document row');
  docEnv.addTimelineComments('beforeNextAction', [
    'user clicks Retry in the panel — the manager requeues the mutation in its store, which revalidates once it is replayed',
  ]);
  const retryResult = await resolveOfflineResolutionThroughManager(
    storeManager,
    docResolution.id,
    'retry',
  );
  await flushAllTimers();

  // The action is reported as applied and the retried replay reached the server.
  expect(retryResult).toMatchInlineSnapshot(`"ok"`);
  expect(updateValueExecute).toHaveBeenCalledTimes(2);
  expect(docEnv.serverMock.current).toMatchInlineSnapshot(`2`);
  expect(docEnv.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

  // --- Action: "Discard" on the collection row, using only the manager ---
  panelRenders.addMark('user clicks Discard on the users row');
  collectionEnv.addTimelineComments('beforeNextAction', [
    'user clicks Discard in the panel — the manager drops the mutation in its store, which refetches the user',
  ]);
  const discardResult = await resolveOfflineResolutionThroughManager(
    storeManager,
    usersResolution.id,
    'discard',
  );
  await flushAllTimers();

  // The discarded rename is dropped for good: it is not replayed again and no
  // offline work is left anywhere in the session.
  expect(discardResult).toMatchInlineSnapshot(`"ok"`);
  expect(renameUserExecute).toHaveBeenCalledTimes(1);
  expect(panel.result.current).toMatchInlineSnapshot(`[]`);
  expect([
    ...docEnv.apiStore.getOfflineEntities(),
    ...collectionEnv.apiStore.getOfflineEntities(),
  ]).toMatchInlineSnapshot(`[]`);

  // The panel went from two problems to none, one row per user action.
  expect(panelRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> problems: []

    >>> reconnect — both replays fail

    -> problems: [manager-resolution-actions-doc › updateValue (retry-exhausted)]
    problems: [manager-resolution-actions-doc › updateValue (retry-exhausted), manager-resolution-actions-users › renameUser (retry-exhausted)]

    >>> user clicks Retry on the document row

    -> problems: [manager-resolution-actions-users › renameUser (retry-exhausted)]

    >>> user clicks Discard on the users row

    -> problems: []
    "
  `);
  // Each store went through the same flow the store-level API produces.
  expect(docEnv.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui                                 |
    0      | "value:1 sync:none"                | ui-initialized
    12s    | "value:2 sync:none"                | ui-changed
    .      | "value:2 sync:pending"             | ui-changed
    .      | "value:2 sync:pending"             | offline:updateValue queued
    .      | "value:2 sync:pending"             | -- reconnect — the replay fails once and requires manual resolution
    .      | "value:2 sync:syncing"             | ui-changed
    .      | "value:2 sync:syncing"             | offline:updateValue replay-started
    .      | "value:2 sync:syncing"             | offline:updateValue resolution-required
    .      | "value:2 sync:resolution-required" | ui-changed
    13s    | "value:2 sync:resolution-required" | -- user clicks Retry in the panel — the manager requeues the mutation in its store, which revalidates once it is replayed
    .      | "value:2 sync:pending"             | ui-changed
    .      | "value:2 sync:syncing"             | ui-changed
    .      | "value:2 sync:syncing"             | offline:updateValue replay-started
    14.2s  | "value:2 sync:syncing"             | server-data-changed (value: 2)
    .      | "value:2 sync:syncing"             | offline:updateValue replay-finished
    .      | "value:2 sync:none"                | ui-changed
    14.21s | "value:2 sync:none"                | 🔴 >fetch-started
    15.01s | "value:2 sync:none"                | 🔴 <fetch-finished (value: 2)
    "
  `);
  expect(collectionEnv.timelineString).toMatchInlineSnapshot(`
    "
    time   | user-1                               |
    0      | Ada sync:none                        | [user-1] ui-initialized
    12s    | Ada renamed sync:pending             | [user-1, user-1] ui-changed
    .      | Ada renamed sync:pending             | offline:renameUser queued
    .      | Ada renamed sync:pending             | -- reconnect — the replay fails once and requires manual resolution
    .      | Ada renamed sync:syncing             | [user-1] ui-changed
    .      | Ada renamed sync:syncing             | offline:renameUser replay-started
    .      | Ada renamed sync:syncing             | offline:renameUser resolution-required
    .      | Ada renamed sync:resolution-required | [user-1] ui-changed
    16.01s | Ada renamed sync:resolution-required | -- user clicks Discard in the panel — the manager drops the mutation in its store, which refetches the user
    .      | Ada renamed sync:none                | [user-1] ui-changed
    16.02s | Ada renamed sync:none                | 🔴 [users||1] >fetch-started
    16.82s | Ada renamed sync:none                | 🔴 [users||1] <fetch-finished (value: {"name":"Ada"})
    .      | Ada sync:none                        | [user-1] ui-changed
    "
  `);

  panel.unmount();
  docScreen.unmount();
  usersScreen.unmount();
});

// Failures the panel must be able to show: the manager reports why an action
// was not applied instead of silently doing nothing.
test('the manager reports why a resolution action could not be applied', async () => {
  network.setOffline();
  const sessionKey = 'manager-resolution-action-errors';
  const offlineSessionConfig: OfflineSessionConfig = {
    network: network.config,
  };
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: offlineSessionConfig,
  });
  const execute = vi.fn(({ input }: { input: { value: number } }) =>
    env.serverMock.delayedSetData(input.value).then(() => input),
  );
  const env = createDocumentStoreTestEnv<number, UpdateValueConflictOperations>(
    1,
    {
      id: 'manager-resolution-action-errors-doc',
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
              execute,
              conflictHandling: {
                schema: docConflictSchema,
                // Every replay is stopped as a conflict before execute runs.
                detectConflict: () => ({ reason: 'server-changed' }),
              },
            },
          },
        },
      },
    },
  );

  // The session-wide panel and the document's own screen.
  const panel = renderHook(() => storeManager.useOfflineResolutions());
  const screen = renderHook(() => {
    const doc = env.apiStore.useDocument();
    const entity = env.apiStore.useOfflineEntities()[0];
    env.trackUIChanges(
      `value:${doc.data?.value ?? 'null'} sync:${entity?.syncState ?? 'none'}`,
    );
  });

  // --- Setup: an offline edit that becomes a conflict record on reconnect ---
  await act(async () => {
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
  });
  env.addTimelineComments('beforeNextAction', [
    'reconnect — the replay is stopped as a conflict before execute runs',
  ]);
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
    await flushAllTimers();
  });

  const [conflict] = panel.result.current;
  if (!conflict) throw new Error('Expected a conflict resolution record');
  expect(summarizeResolution(conflict)).toMatchInlineSnapshot(`
    input: 'value: 2'
    kind: 'conflict'
    on: 'document:document'
    op: 'updateValue'
    reason: 'server-changed'
  `);

  // --- Unknown id: e.g. a stale row that was already resolved elsewhere ---
  expect(
    await resolveOfflineResolutionThroughManager(
      storeManager,
      'already-resolved-id',
      'discard',
    ),
  ).toMatchInlineSnapshot(`
    error: 'resolution-not-found'
    message: '[tsdf] Offline resolution not found in the active session'
  `);

  // --- Retry on a conflict: a conflict is not a failed attempt that can be
  // sent again as-is. Besides `discard`, it is resolved with `requeue` /
  // `commit`, which need operation-typed input and stay on the store API ---
  expect(
    await resolveOfflineResolutionThroughManager(
      storeManager,
      conflict.id,
      'retry',
    ),
  ).toMatchInlineSnapshot(`
    error: 'retry-not-supported'
    message: '[tsdf] Only retry-exhausted offline resolutions can be retried'
    storeName: 'manager-resolution-action-errors-doc'
  `);

  // --- Owning store not created with this manager: resolutions are shared by
  // the whole session, so a manager that did not create the store can list a
  // record it cannot act on (in production: a tab that has not created that
  // store, since tabs share the session's resolutions) ---
  const panelOnlyManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: offlineSessionConfig,
  });
  const panelOnlyResolutions = renderHook(() =>
    panelOnlyManager.useOfflineResolutions(),
  );
  // The second manager lists the conflict even though it never created the
  // store that owns it.
  expect(
    panelOnlyResolutions.result.current.map((resolution) => ({
      store: resolution.storeName,
      ...summarizeResolution(resolution),
    })),
  ).toMatchInlineSnapshot(`
    - input: 'value: 2'
      kind: 'conflict'
      on: 'document:document'
      op: 'updateValue'
      reason: 'server-changed'
      store: 'manager-resolution-action-errors-doc'
  `);
  expect(
    await resolveOfflineResolutionThroughManager(
      panelOnlyManager,
      conflict.id,
      'discard',
    ),
  ).toMatchInlineSnapshot(`
    error: 'store-not-registered'
    message: '[tsdf] The store that owns this offline resolution is not registered in this manager'
    storeName: 'manager-resolution-action-errors-doc'
  `);

  // None of the rejected actions touched the record or replayed the mutation.
  expect(panel.result.current).toHaveLength(1);
  expect(panel.result.current[0]).toEqual(conflict);
  expect(execute).not.toHaveBeenCalled();

  // --- The generic action a conflict does support still works ---
  env.addTimelineComments('beforeNextAction', [
    'the rejected actions above left no trace — discard through the manager drops the conflict and refetches the document',
  ]);
  const discardResult = await resolveOfflineResolutionThroughManager(
    storeManager,
    conflict.id,
    'discard',
  );
  await flushAllTimers();

  expect(discardResult).toMatchInlineSnapshot(`"ok"`);
  expect(panel.result.current).toMatchInlineSnapshot(`[]`);
  expect(panelOnlyResolutions.result.current).toMatchInlineSnapshot(`[]`);
  expect(execute).not.toHaveBeenCalled();
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui                                 |
    0      | "value:1 sync:none"                | ui-initialized
    .      | "value:2 sync:none"                | ui-changed
    .      | "value:2 sync:pending"             | ui-changed
    .      | "value:2 sync:pending"             | offline:updateValue queued
    .      | "value:2 sync:pending"             | -- reconnect — the replay is stopped as a conflict before execute runs
    .      | "value:2 sync:syncing"             | ui-changed
    .      | "value:2 sync:syncing"             | offline:updateValue resolution-required
    .      | "value:2 sync:resolution-required" | ui-changed
    10ms   | "value:2 sync:resolution-required" | 🔴 >fetch-started
    810ms  | "value:2 sync:resolution-required" | 🔴 <fetch-finished (value: 1)
    .      | "value:1 sync:resolution-required" | ui-changed
    12s    | "value:1 sync:resolution-required" | -- the rejected actions above left no trace — discard through the manager drops the conflict and refetches the document
    .      | "value:1 sync:none"                | ui-changed
    12.01s | "value:1 sync:none"                | 🟠 >fetch-started
    12.81s | "value:1 sync:none"                | 🟠 <fetch-finished (value: 1)
    "
  `);

  panel.unmount();
  screen.unmount();
  panelOnlyResolutions.unmount();
});
