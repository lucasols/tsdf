import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createStoreManager } from '../../src/storeManager';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { withSuppressedActError } from '../utils/withSuppressedActError';
import {
  getSortedQueueSummary,
  type UpdateValueOperations,
} from './offlineReplayTestShared';
import { createReplayFailure } from './offlineReplayTestShared';
import {
  classifyRetryableReplayFailure,
  docMutationInputSchema,
  docSchema,
  summarizeResolution,
  waitForMicrotaskCondition,
} from './offlineTestShared';

function formatReplayState(
  doc: { data: { value: number } | null } | undefined,
  entity: { syncState: string; pendingMutations: number } | undefined,
) {
  return `value:${doc?.data?.value ?? 'null'} sync:${entity?.syncState ?? 'none'} pending:${entity?.pendingMutations ?? 0}`;
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

test('ambiguous replay failures are discarded when the server confirms the mutation was already applied', async () => {
  network.setOffline();
  let skipCheckEnqueuedAt: number | null = null;

  // The first execute throws to simulate an ambiguous failure — the mutation
  // may or may not have reached the server, so the entry moves to
  // needs-confirmation state.
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
      throw createReplayFailure(`dispatch failed after send ${input.value}`);
    });
  // shouldSkipSync returns true — confirming the mutation was already applied
  // on the server, so the entry should be discarded without re-sending.
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
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'needs-confirmation-session',
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
            execute,
            onSuccessExecute: ({ input }) => {
              env.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
            },
            shouldSkipSync,
          },
        },
      },
    },
  });

  renderHook(() => {
    const doc = env.apiStore.useDocument();
    const entity = env.apiStore.useOfflineEntities()[0];
    env.trackUIChanges(formatReplayState(doc, entity));
  });

  // Queue a mutation while offline.
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

  // Go online — the first replay attempt fails, moving the entry to
  // needs-confirmation. After the retry interval, shouldSkipSync is called
  // and returns true, so the entry is removed without retrying execute.
  env.addTimelineComments('beforeNextAction', [
    'go online — replay fails ambiguously, then shouldSkipSync confirms it was already applied',
  ]);
  await withSuppressedActError(async () => {
    act(() => {
      network.goOnline();
    });
    await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);
    await advanceTime(5_000);
    await flushAllTimers();
  });

  // Execute was only called once (the failed attempt); shouldSkipSync
  // confirmed the mutation was already applied, so no further retries.
  expect(execute).toHaveBeenCalledTimes(1);
  expect(shouldSkipSync).toHaveBeenCalledTimes(1);
  expect(skipCheckEnqueuedAt).toBe(TEST_INITIAL_TIME);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                                          |
    0     | "value:1 sync:none pending:0"               | ui-initialized
    .     | "value:2 sync:none pending:0"               | ui-changed
    .     | "value:2 sync:pending pending:1"            | ui-changed
    .     | "value:2 sync:pending pending:1"            | offline:updateValue queued
    .     | "value:2 sync:pending pending:1"            | -- go online — replay fails ambiguously, then shouldSkipSync confirms it was already applied
    .     | "value:2 sync:syncing pending:1"            | ui-changed
    .     | "value:2 sync:syncing pending:1"            | offline:updateValue replay-started
    .     | "value:2 sync:needs-confirmation pending:1" | ui-changed
    10ms  | "value:2 sync:needs-confirmation pending:1" | 🔴 >fetch-started
    810ms | "value:2 sync:needs-confirmation pending:1" | 🔴 <fetch-finished (value: 1)
    5s    | "value:2 sync:syncing pending:1"            | ui-changed
    .     | "value:1 sync:none pending:0"               | ui-changed
    5.01s | "value:1 sync:none pending:0"               | 🟠 >fetch-started
    5.81s | "value:1 sync:none pending:0"               | 🟠 <fetch-finished (value: 1)
    "
  `);
});

test('ambiguous replay failures are retried when the server confirms the mutation was not applied', async () => {
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
      throw createReplayFailure(`dispatch failed after send ${input.value}`);
    })
    .mockImplementation(async ({ input }) => {
      await env.serverMock.delayedSetData(input.value, { durationMs: 0 });
      return { value: env.serverMock.current };
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
      return Promise.resolve(false);
    });

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'needs-confirmation-no-outage-session',
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'needs-confirmation-no-outage-session',
      offlineSession: {
        network: network.config,
        classifyRetryableFailure: (error, ctx) =>
          classifyRetryableReplayFailure(error, ctx.phase),
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
            shouldSkipSync,
          },
        },
      },
    },
  });

  renderHook(() => {
    const doc = env.apiStore.useDocument();
    const entity = env.apiStore.useOfflineEntities()[0];
    env.trackUIChanges(formatReplayState(doc, entity));
  });

  let mutationResult!: Awaited<ReturnType<typeof env.apiStore.performMutation>>;
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
  expect(mutationResult.ok).toBe(true);

  await advanceTime(100);

  // The first online replay should settle into syncing before the retry
  // window has a chance to decide whether the queued mutation should continue.
  env.addTimelineComments('beforeNextAction', [
    'bring the session online and wait for the first replay attempt to settle into syncing',
  ]);
  act(() => {
    network.goOnline();
  });
  await withSuppressedActError(async () => {
    await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);
  });

  expect(execute).toHaveBeenCalledTimes(1);
  expect(shouldSkipSync).toHaveBeenCalledTimes(0);

  // After the retry window opens, the same queued mutation should replay
  // again instead of staying paused forever.
  env.addTimelineComments('beforeNextAction', [
    'advance the retry window so shouldSkipSync can allow the queued mutation to replay again',
  ]);
  await advanceTime(5_000);
  await flushAllTimers();

  expect(shouldSkipSync).toHaveBeenCalledTimes(1);
  expect(skipCheckEnqueuedAt).toBe(TEST_INITIAL_TIME);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui                                          |
    0      | "value:1 sync:none pending:0"               | ui-initialized
    .      | "value:2 sync:none pending:0"               | ui-changed
    .      | "value:2 sync:pending pending:1"            | ui-changed
    .      | "value:2 sync:pending pending:1"            | offline:updateValue queued
    100ms  | "value:2 sync:pending pending:1"            | -- bring the session online and wait for the first replay attempt to settle into syncing
    .      | "value:2 sync:syncing pending:1"            | ui-changed
    .      | "value:2 sync:syncing pending:1"            | offline:updateValue replay-started
    .      | "value:2 sync:syncing pending:1"            | -- advance the retry window so shouldSkipSync can allow the queued mutation to replay again
    .      | "value:2 sync:needs-confirmation pending:1" | ui-changed
    5.1s   | "value:2 sync:syncing pending:1"            | ui-changed
    .      | "value:2 sync:syncing pending:1"            | offline:updateValue replay-started
    5.101s | "value:2 sync:syncing pending:1"            | server-data-changed (value: 2)
    .      | "value:2 sync:syncing pending:1"            | offline:updateValue replay-finished
    .      | "value:2 sync:none pending:0"               | ui-changed
    5.111s | "value:2 sync:none pending:0"               | 🔴 >fetch-started
    5.911s | "value:2 sync:none pending:0"               | 🔴 <fetch-finished (value: 2)
    "
  `);
});

test('ambiguous replay failures require manual resolution by default instead of auto-retrying', async () => {
  network.setOffline();
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockRejectedValue(createReplayFailure('replay failed'));

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: 'retry-default-safe-store',
    getSessionKey: () => 'retry-default-safe-session',
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'retry-default-safe-session',
      offlineSession: {
        network: network.config,
        replayRetry: { intervalMs: 1 },
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
          },
        },
      },
    },
  });

  await act(async () => {
    await env.apiStore.performMutation({
      mutation: async () => {
        await env.serverMock.delayedSetData(2);
        return 2;
      },
      offline: { operation: 'updateValue', input: { value: 2 } },
    });
  });

  act(() => {
    network.goOnline();
  });
  await advanceTime(1);
  await flushAllTimers();

  // The failed replay is not auto-sent again unless the session explicitly
  // opts into replay retries for that failure shape.
  expect(execute).toHaveBeenCalledTimes(1);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600001
      entityKey: 'document'
      entityKind: 'document'
      id: 'retry-default-safe-session:retry-default-safe-store:document'
      kind: 'update'
      pendingMutations: 0
      requiresResolution: '✅'
      sessionKey: 'retry-default-safe-session'
      storeName: 'retry-default-safe-store'
      storeType: 'document'
      syncState: 'resolution-required'
      updatedAt: 1735689600001
  `);
  expect(env.apiStore.getOfflineResolutions().map(summarizeResolution))
    .toMatchInlineSnapshot(`
      - error: 'replay failed'
        input: 'value: 2'
        kind: 'retry-exhausted'
        on: 'document:document'
        op: 'updateValue'
    `);
});

test('healthy replay failures are retried 3 times and then move into the resolution queue', async () => {
  network.setOffline();
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockRejectedValue(createReplayFailure('replay failed'));

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'retry-exhaustion-session',
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'retry-exhaustion-session',
      offlineSession: {
        network: network.config,
        classifyRetryableFailure: (error, ctx) =>
          classifyRetryableReplayFailure(error, ctx.phase),
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
          },
        },
      },
    },
  });

  renderHook(() => {
    const doc = env.apiStore.useDocument();
    const entity = env.apiStore.useOfflineEntities()[0];
    env.trackUIChanges(formatReplayState(doc, entity));
  });

  await act(async () => {
    await env.apiStore.performMutation({
      mutation: async () => {
        await env.serverMock.delayedSetData(2);
        return 2;
      },
      offline: { operation: 'updateValue', input: { value: 2 } },
    });
  });

  // Bring the browser back online so the first replay failure can start the
  // healthy retry budget for this queued mutation.
  env.addTimelineComments('beforeNextAction', [
    'bring the browser back online so the first replay failure starts the healthy retry budget',
  ]);
  act(() => {
    network.goOnline();
  });
  await withSuppressedActError(async () => {
    await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);
  });

  // Keep the session online long enough to spend the remaining retry budget.
  env.addTimelineComments('beforeNextAction', [
    'keep the session online long enough to spend the remaining healthy retry budget',
  ]);
  for (const attempt of [2, 3]) {
    await advanceTime(5_000);
    await withSuppressedActError(async () => {
      await waitForMicrotaskCondition(
        () => execute.mock.calls.length === attempt,
      );
    });
  }
  await flushAllTimers();

  expect(execute).toHaveBeenCalledTimes(3);

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689610000
      entityKey: 'document'
      entityKind: 'document'
      id: 'retry-exhaustion-session:document-3:document'
      kind: 'update'
      pendingMutations: 0
      requiresResolution: '✅'
      sessionKey: 'retry-exhaustion-session'
      storeName: 'document-3'
      storeType: 'document'
      syncState: 'resolution-required'
      updatedAt: 1735689610000
  `);

  expect(env.apiStore.getOfflineResolutions().map(summarizeResolution))
    .toMatchInlineSnapshot(`
      - error: 'replay failed'
        input: 'value: 2'
        kind: 'retry-exhausted'
        on: 'document:document'
        op: 'updateValue'
    `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                                           |
    0     | "value:1 sync:none pending:0"                | ui-initialized
    .     | "value:1 sync:pending pending:1"             | ui-changed
    .     | "value:1 sync:pending pending:1"             | offline:updateValue queued
    .     | "value:1 sync:pending pending:1"             | -- bring the browser back online so the first replay failure starts the healthy retry budget
    .     | "value:1 sync:syncing pending:1"             | ui-changed
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .     | "value:1 sync:syncing pending:1"             | -- keep the session online long enough to spend the remaining healthy retry budget
    .     | "value:1 sync:needs-confirmation pending:1"  | ui-changed
    10ms  | "value:1 sync:needs-confirmation pending:1"  | 🔴 >fetch-started
    810ms | "value:1 sync:needs-confirmation pending:1"  | 🔴 <fetch-finished (value: 1)
    5s    | "value:1 sync:syncing pending:1"             | ui-changed
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .     | "value:1 sync:needs-confirmation pending:1"  | ui-changed
    10s   | "value:1 sync:syncing pending:1"             | ui-changed
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue resolution-required
    .     | "value:1 sync:resolution-required pending:0" | ui-changed
    "
  `);
});

test('retry-exhausted resolutions can retry or discard queued work', async () => {
  network.setOffline();
  // Execute call schedule:
  //   calls 1–3: fail (exhaust first retry budget → resolution)
  //   call 4: succeed (after user resolves with "retry")
  //   calls 5–7: fail (exhaust second retry budget → another resolution)
  let replayAttempt = 0;
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockImplementation(async ({ input }) => {
      replayAttempt += 1;

      if (replayAttempt === 4) {
        await env.serverMock.delayedSetData(input.value, { durationMs: 0 });
        return { value: env.serverMock.current };
      }

      throw createReplayFailure('replay failed');
    });

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'retry-resolution-actions-session',
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'retry-resolution-actions-session',
      offlineSession: {
        network: network.config,
        classifyRetryableFailure: (error, ctx) =>
          classifyRetryableReplayFailure(error, ctx.phase),
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
          },
        },
      },
    },
  });

  renderHook(() => {
    const doc = env.apiStore.useDocument();
    const entity = env.apiStore.useOfflineEntities()[0];
    env.trackUIChanges(formatReplayState(doc, entity));
  });

  const queueOfflineMutation = async () => {
    await act(async () => {
      await env.apiStore.performMutation({
        mutation: async () => {
          await env.serverMock.delayedSetData(2);
          return 2;
        },
        offline: { operation: 'updateValue', input: { value: 2 } },
      });
    });
  };

  // --- Phase 1: Exhaust the retry budget to produce a resolution ---
  await queueOfflineMutation();

  // Go online and let all 3 retry attempts fail.
  env.addTimelineComments('beforeNextAction', [
    'go online — exhaust the 3-attempt retry budget',
  ]);
  act(() => {
    network.goOnline();
  });
  await withSuppressedActError(async () => {
    await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);
  });
  for (const attempt of [2, 3]) {
    await advanceTime(5_000);
    await withSuppressedActError(async () => {
      await waitForMicrotaskCondition(
        () => execute.mock.calls.length === attempt,
      );
    });
  }
  await flushAllTimers();

  // The mutation should now be in the resolution queue as retry-exhausted.
  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution || resolution.kind !== 'retry-exhausted') {
    throw new Error('Expected a retry-exhausted resolution');
  }

  expect(summarizeResolution(resolution)).toMatchInlineSnapshot(`
    error: 'replay failed'
    input: 'value: 2'
    kind: 'retry-exhausted'
    on: 'document:document'
    op: 'updateValue'
  `);

  // Retry-exhausted entries have no conflict data, so parsing returns a
  // not-conflict error rather than a typed conflict payload.
  const parseRetryResult =
    env.apiStore.parseOfflineResolutionConflict(resolution);
  expect(parseRetryResult.ok).toBe(false);
  if (!parseRetryResult.ok) {
    expect({
      code: parseRetryResult.error.code,
      kind: parseRetryResult.error.kind,
      name: parseRetryResult.error.name,
      operation: parseRetryResult.error.operation,
    }).toMatchInlineSnapshot(`
      code: 'not-conflict'
      kind: 'retry-exhausted'
      name: 'OfflineResolutionConflictParseError'
      operation: 'updateValue'
    `);
  }

  // --- Phase 2: Resolve with "retry" — should re-enqueue and succeed ---
  env.addTimelineComments('beforeNextAction', [
    'user resolves with "retry" — entry re-enqueued, 4th execute call succeeds',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(resolution.id, 'updateValue', {
      action: 'retry',
    });
  });
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

  // The 4th execute call succeeds, clearing the queue.
  await withSuppressedActError(async () => {
    await waitForMicrotaskCondition(() => execute.mock.calls.length === 4);
  });
  await flushAllTimers();

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);

  // --- Phase 3: Queue another mutation and exhaust retries again to test discard ---
  env.addTimelineComments('beforeNextAction', [
    'go offline, queue another mutation, come back online — exhaust retries again',
  ]);
  await act(async () => {
    network.goOffline();
    await Promise.resolve();
  });
  await queueOfflineMutation();
  act(() => {
    network.goOnline();
  });
  await withSuppressedActError(async () => {
    await waitForMicrotaskCondition(() => execute.mock.calls.length === 5);
  });
  // All further execute calls fail — exhaust the retry budget again.
  for (const attempt of [6, 7]) {
    await advanceTime(5_000);
    await withSuppressedActError(async () => {
      await waitForMicrotaskCondition(
        () => execute.mock.calls.length === attempt,
      );
    });
  }
  await flushAllTimers();

  // Another retry-exhausted resolution should be in the queue.
  const [discardResolution] = env.apiStore.getOfflineResolutions();
  if (!discardResolution || discardResolution.kind !== 'retry-exhausted') {
    throw new Error('Expected a retry-exhausted discard resolution');
  }

  expect(summarizeResolution(discardResolution)).toMatchInlineSnapshot(`
    error: 'replay failed'
    input: 'value: 2'
    kind: 'retry-exhausted'
    on: 'document:document'
    op: 'updateValue'
  `);

  const parseDiscardResult =
    env.apiStore.parseOfflineResolutionConflict(discardResolution);
  expect(parseDiscardResult.ok).toBe(false);
  if (!parseDiscardResult.ok) {
    expect({
      code: parseDiscardResult.error.code,
      kind: parseDiscardResult.error.kind,
      name: parseDiscardResult.error.name,
      operation: parseDiscardResult.error.operation,
    }).toMatchInlineSnapshot(`
      code: 'not-conflict'
      kind: 'retry-exhausted'
      name: 'OfflineResolutionConflictParseError'
      operation: 'updateValue'
    `);
  }

  // --- Phase 4: Resolve with "discard" — should permanently remove the entry ---
  env.addTimelineComments('beforeNextAction', [
    'user resolves with "discard" — entry permanently removed',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      discardResolution.id,
      'updateValue',
      { action: 'discard' },
    );
  });
  // Let the refetch that follows the discard finish.
  await flushAllTimers();

  // Both resolutions and entities should be empty after discard.
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);

  // Full timeline showing the retry → resolve → retry → discard lifecycle.
  // The discard ends with a refetch (🟡), so the document shows the server
  // value again instead of what the discarded change left behind.
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui                                           |
    0      | "value:1 sync:none pending:0"                | ui-initialized
    .      | "value:1 sync:pending pending:1"             | ui-changed
    .      | "value:1 sync:pending pending:1"             | offline:updateValue queued
    .      | "value:1 sync:pending pending:1"             | -- go online — exhaust the 3-attempt retry budget
    .      | "value:1 sync:syncing pending:1"             | ui-changed
    .      | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .      | "value:1 sync:needs-confirmation pending:1"  | ui-changed
    10ms   | "value:1 sync:needs-confirmation pending:1"  | 🔴 >fetch-started
    810ms  | "value:1 sync:needs-confirmation pending:1"  | 🔴 <fetch-finished (value: 1)
    5s     | "value:1 sync:syncing pending:1"             | ui-changed
    .      | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .      | "value:1 sync:needs-confirmation pending:1"  | ui-changed
    10s    | "value:1 sync:syncing pending:1"             | ui-changed
    .      | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .      | "value:1 sync:syncing pending:1"             | offline:updateValue resolution-required
    .      | "value:1 sync:resolution-required pending:0" | ui-changed
    .      | "value:1 sync:resolution-required pending:0" | -- user resolves with "retry" — entry re-enqueued, 4th execute call succeeds
    .      | "value:1 sync:pending pending:1"             | ui-changed
    .      | "value:1 sync:syncing pending:1"             | ui-changed
    .      | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .      | "value:1 sync:syncing pending:1"             | server-data-changed (value: 2)
    .      | "value:1 sync:syncing pending:1"             | offline:updateValue replay-finished
    .      | "value:2 sync:none pending:0"                | ui-changed
    10.01s | "value:2 sync:none pending:0"                | 🟠 >fetch-started
    10.81s | "value:2 sync:none pending:0"                | 🟠 <fetch-finished (value: 2)
    11.81s | "value:2 sync:none pending:0"                | -- go offline, queue another mutation, come back online — exhaust retries again
    .      | "value:2 sync:pending pending:1"             | ui-changed
    .      | "value:2 sync:pending pending:1"             | offline:updateValue queued
    .      | "value:2 sync:syncing pending:1"             | ui-changed
    .      | "value:2 sync:syncing pending:1"             | offline:updateValue replay-started
    .      | "value:2 sync:needs-confirmation pending:1"  | ui-changed
    16.81s | "value:2 sync:syncing pending:1"             | ui-changed
    .      | "value:2 sync:syncing pending:1"             | offline:updateValue replay-started
    .      | "value:2 sync:needs-confirmation pending:1"  | ui-changed
    21.81s | "value:2 sync:syncing pending:1"             | ui-changed
    .      | "value:2 sync:syncing pending:1"             | offline:updateValue replay-started
    .      | "value:2 sync:syncing pending:1"             | offline:updateValue resolution-required
    .      | "value:2 sync:resolution-required pending:0" | ui-changed
    .      | "value:2 sync:resolution-required pending:0" | -- user resolves with "discard" — entry permanently removed
    .      | "value:2 sync:none pending:0"                | ui-changed
    21.82s | "value:2 sync:none pending:0"                | 🟡 >fetch-started
    22.62s | "value:2 sync:none pending:0"                | 🟡 <fetch-finished (value: 2)
    "
  `);
});

test('outage-classified replay failures do not count toward retry exhaustion', async () => {
  network.setOffline();
  // First attempt fails with an outage error (should not count toward the retry
  // budget), second attempt fails with a healthy error (should count), third
  // attempt succeeds.
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockImplementationOnce(() => {
      throw createReplayFailure('outage');
    })
    .mockImplementationOnce(() => {
      throw createReplayFailure('healthy failure');
    })
    .mockImplementation(async ({ input }) => {
      await env.serverMock.delayedSetData(input.value, { durationMs: 0 });
      return { value: env.serverMock.current };
    });
  const recoveryCheck = vi
    .fn<({ sessionKey }: { sessionKey: string }) => boolean>()
    .mockReturnValue(true);

  // Configure a low retry budget (maxFailures: 2) so the test can verify that
  // the outage failure doesn't consume from it while the healthy failure does.
  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'retry-outage-session',
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'retry-outage-session',
      offlineSession: {
        network: { enabled: true },
        classifyFailure: (error, ctx) =>
          ctx.phase === 'sync' &&
          error instanceof Error &&
          error.message === 'outage'
            ? 'outage'
            : 'ignore',
        classifyRetryableFailure: (error, ctx) =>
          classifyRetryableReplayFailure(error, ctx.phase),
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
          },
        },
      },
    },
  });

  // Queue a mutation while offline.
  await env.apiStore.performMutation({
    mutation: async () => {
      await env.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  // Go online and let two replay attempts run: the first triggers an outage
  // (which fires a recovery probe), the second is a healthy failure.
  act(() => {
    network.goOnline();
  });
  await advanceTime(60);
  await waitForMicrotaskCondition(() => execute.mock.calls.length === 2);

  // The outage triggered one recovery check. Since maxFailures is 2 and only
  // one healthy failure has occurred, the entry should NOT be in the resolution
  // queue — it should still be retryable.
  expect(recoveryCheck).toHaveBeenCalledTimes(1);
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

  // The entry remains in needs-confirmation rather than being exhausted,
  // proving the outage failure did not count toward the retry budget.
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689600000
      entityKey: 'document'
      entityKind: 'document'
      id: 'retry-outage-session:document-5:document'
      kind: 'update'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'retry-outage-session'
      storeName: 'document-5'
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
      throw createReplayFailure(`healthy failure ${countedFailures}`);
    });

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'retry-budget-reset-session',
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'retry-budget-reset-session',
      offlineSession: {
        network: network.config,
        classifyRetryableFailure: (error, ctx) =>
          classifyRetryableReplayFailure(error, ctx.phase),
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
          },
        },
      },
    },
  });

  renderHook(() => {
    const doc = env.apiStore.useDocument();
    const entity = env.apiStore.useOfflineEntities()[0];
    env.trackUIChanges(formatReplayState(doc, entity));
  });

  await act(async () => {
    await env.apiStore.performMutation({
      mutation: async () => {
        await env.serverMock.delayedSetData(2);
        return 2;
      },
      offline: { operation: 'updateValue', input: { value: 2 } },
    });
  });

  // Start replaying while online, but stop before the queued mutation has
  // exhausted its healthy retry budget.
  env.addTimelineComments('beforeNextAction', [
    'start replaying online, but stop before the queued mutation exhausts its healthy retry budget',
  ]);
  act(() => {
    network.goOnline();
  });
  await withSuppressedActError(async () => {
    await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);
  });

  env.addTimelineComments('beforeNextAction', [
    'keep retrying until the mutation has spent only part of its healthy retry budget',
  ]);
  for (const attempt of [2]) {
    await advanceTime(5_000);
    await withSuppressedActError(async () => {
      await waitForMicrotaskCondition(
        () => execute.mock.calls.length === attempt,
      );
    });
  }

  // Going offline while the queued mutation is paused in needs-confirmation
  // should let the next online transition restart the healthy retry budget.
  env.addTimelineComments('beforeNextAction', [
    'go offline again while the queued mutation is paused in needs-confirmation',
  ]);
  await act(async () => {
    network.goOffline();
    await Promise.resolve();
  });

  env.addTimelineComments('beforeNextAction', [
    'come back online and verify the paused mutation gets a fresh healthy retry budget',
  ]);
  act(() => {
    network.goOnline();
  });
  await withSuppressedActError(async () => {
    await waitForMicrotaskCondition(() => execute.mock.calls.length === 3);
  });

  env.addTimelineComments('beforeNextAction', [
    'spend the fresh retry budget; only after these new failures should the mutation require resolution',
  ]);
  for (const attempt of [4, 5]) {
    await advanceTime(5_000);
    await withSuppressedActError(async () => {
      await waitForMicrotaskCondition(
        () => execute.mock.calls.length === attempt,
      );
    });
  }
  await flushAllTimers();

  expect(env.apiStore.getOfflineResolutions().map(summarizeResolution))
    .toMatchInlineSnapshot(`
      - error: 'healthy failure 5'
        input: 'value: 2'
        kind: 'retry-exhausted'
        on: 'document:document'
        op: 'updateValue'
    `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                                           |
    0     | "value:1 sync:none pending:0"                | ui-initialized
    .     | "value:1 sync:pending pending:1"             | ui-changed
    .     | "value:1 sync:pending pending:1"             | offline:updateValue queued
    .     | "value:1 sync:pending pending:1"             | -- start replaying online, but stop before the queued mutation exhausts its healthy retry budget
    .     | "value:1 sync:syncing pending:1"             | ui-changed
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .     | "value:1 sync:syncing pending:1"             | -- keep retrying until the mutation has spent only part of its healthy retry budget
    .     | "value:1 sync:needs-confirmation pending:1"  | ui-changed
    10ms  | "value:1 sync:needs-confirmation pending:1"  | 🔴 >fetch-started
    810ms | "value:1 sync:needs-confirmation pending:1"  | 🔴 <fetch-finished (value: 1)
    5s    | "value:1 sync:syncing pending:1"             | ui-changed
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .     | "value:1 sync:needs-confirmation pending:1"  | ui-changed
    .     | "value:1 sync:needs-confirmation pending:1"  | -- go offline again while the queued mutation is paused in needs-confirmation
    .     | "value:1 sync:needs-confirmation pending:1"  | -- come back online and verify the paused mutation gets a fresh healthy retry budget
    .     | "value:1 sync:syncing pending:1"             | ui-changed
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .     | "value:1 sync:syncing pending:1"             | -- spend the fresh retry budget; only after these new failures should the mutation require resolution
    .     | "value:1 sync:needs-confirmation pending:1"  | ui-changed
    10s   | "value:1 sync:syncing pending:1"             | ui-changed
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .     | "value:1 sync:needs-confirmation pending:1"  | ui-changed
    15s   | "value:1 sync:syncing pending:1"             | ui-changed
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue replay-started
    .     | "value:1 sync:syncing pending:1"             | offline:updateValue resolution-required
    .     | "value:1 sync:resolution-required pending:0" | ui-changed
    "
  `);
});

test('new mutations queue separately instead of merging into entries that may have already been applied', async () => {
  network.setOffline();
  // First attempt fails (simulating ambiguous send), second attempt succeeds.
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockImplementationOnce(() => {
      throw createReplayFailure('dispatch failed after send');
    })
    .mockImplementation(async ({ input }) => {
      await env.serverMock.delayedSetData(input.value, { durationMs: 0 });
      return { value: env.serverMock.current };
    });

  // Use accumulation so we can verify that new mutations do NOT merge into an
  // entry that may have already been applied on the server.
  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => 'offline-needs-confirmation-accumulation-session',
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'offline-needs-confirmation-accumulation-session',
      offlineSession: { network: { enabled: true } },
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
            execute,
            onSuccessExecute: ({ input }) => {
              env.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
            },
            shouldSkipSync: () => false,
          },
        },
      },
    },
  });
  await Promise.resolve();

  // Queue a mutation while offline.
  await env.apiStore.performMutation({
    mutation: async () => {
      await env.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  // Go online — execute fails, moving the entry to needs-confirmation.
  act(() => {
    network.goOnline();
  });
  await advanceTime(1);
  await Promise.resolve();

  // The entry is now in needs-confirmation — it may have already been applied
  // on the server, so it's unsafe to merge new input into it.
  expect(
    env.apiStore
      .getOfflineEntities()
      .map((e) => pick(e, ['syncState', 'pendingMutations'])),
  ).toMatchInlineSnapshot(
    `- { pendingMutations: 1, syncState: 'needs-confirmation' }`,
  );

  // Go offline again and queue a second mutation.
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  await env.apiStore.performMutation({
    mutation: async () => {
      await env.serverMock.delayedSetData(3);
      return 3;
    },
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  // The second mutation creates a separate pending entry (pendingMutations: 2)
  // rather than merging into the needs-confirmation entry — because the first
  // entry may have already been applied and merging could corrupt the data.
  expect(
    env.apiStore
      .getOfflineEntities()
      .map((e) => pick(e, ['syncState', 'pendingMutations'])),
  ).toMatchInlineSnapshot(
    `- { pendingMutations: 2, syncState: 'needs-confirmation' }`,
  );
});

test('supersede does not discard entries that may have already been applied on the server', async () => {
  network.setOffline();
  const sessionKey = 'offline-needs-confirmation-supersede-session';
  const storeName = 'offline-needs-confirmation-supersede-store';
  const execute = vi
    .fn<
      ({ input }: { input: { value: number } }) => Promise<{ value: number }>
    >()
    .mockImplementationOnce(() => {
      throw createReplayFailure('dispatch failed after send');
    })
    .mockImplementation(async ({ input }) => {
      await env.serverMock.delayedSetData(input.value, { durationMs: 0 });
      return { value: env.serverMock.current };
    });

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
            supersedes: { scope: 'same-entity' },
            execute,
            onSuccessExecute: ({ input }) => {
              env.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
            },
            shouldSkipSync: () => false,
          },
        },
      },
    },
  });

  // Let the first queued mutation reach needs-confirmation before adding a new one.
  await env.apiStore.performMutation({
    mutation: async () => {
      await env.serverMock.delayedSetData(2);
      return 2;
    },
    offline: { operation: 'updateValue', input: { value: 2 } },
  });

  act(() => {
    network.goOnline();
  });
  await advanceTime(1);
  await Promise.resolve();

  // Verify the first entry reached needs-confirmation before proceeding.
  expect(
    env.apiStore
      .getOfflineEntities()
      .map((e) => pick(e, ['syncState', 'pendingMutations'])),
  ).toMatchInlineSnapshot(
    `- { pendingMutations: 1, syncState: 'needs-confirmation' }`,
  );

  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  // The new superseding entry should not remove the already-attempted one.
  await env.apiStore.performMutation({
    mutation: async () => {
      await env.serverMock.delayedSetData(3);
      return 3;
    },
    offline: { operation: 'updateValue', input: { value: 3 } },
  });

  // Both queue entries should be preserved: the needs-confirmation one and
  // the new pending one — the supersede did NOT discard the already-attempted entry.
  expect(
    getSortedQueueSummary(sessionKey, storeName, [
      'input',
      'operation',
      'syncState',
    ]),
  ).toMatchInlineSnapshot(`
    - input: { value: 2 }
      operation: 'updateValue'
      syncState: 'needs-confirmation'
    - input: { value: 3 }
      operation: 'updateValue'
      syncState: 'pending'
  `);

  // The entity should now have 2 pending mutations: the original
  // needs-confirmation entry was preserved (not superseded).
  expect(
    env.apiStore
      .getOfflineEntities()
      .map((e) => pick(e, ['syncState', 'pendingMutations'])),
  ).toMatchInlineSnapshot(
    `- { pendingMutations: 2, syncState: 'needs-confirmation' }`,
  );
});

test('ambiguous entries are periodically re-checked for server confirmation while online', async () => {
  network.setOffline();
  let skipCheckEnqueuedAt: number | null = null;
  // First attempt throws (ambiguous failure), no further execute calls expected
  // since shouldSkipSync keeps returning true to discard the entry.
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
      throw createReplayFailure(`dispatch failed after send ${input.value}`);
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
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'online-needs-confirmation-retry-session',
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
            execute,
            onSuccessExecute: ({ input }) => {
              env.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
            },
            shouldSkipSync,
          },
        },
      },
    },
  });

  renderHook(() => {
    const doc = env.apiStore.useDocument();
    const entity = env.apiStore.useOfflineEntities()[0];
    env.trackUIChanges(formatReplayState(doc, entity));
  });

  // Queue a mutation while offline.
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

  // Go online — execute fails, entry moves to needs-confirmation.
  // shouldSkipSync is NOT called immediately — only after the retry interval.
  env.addTimelineComments('beforeNextAction', [
    'go online — execute fails ambiguously, entry moves to needs-confirmation',
  ]);
  act(() => {
    network.goOnline();
  });
  await withSuppressedActError(async () => {
    await waitForMicrotaskCondition(() => execute.mock.calls.length === 1);
    await waitForMicrotaskCondition(
      () =>
        env.apiStore.getOfflineEntities()[0]?.syncState ===
        'needs-confirmation',
    );
  });

  expect(execute).toHaveBeenCalledTimes(1);
  expect(shouldSkipSync).toHaveBeenCalledTimes(0);

  // After the retry interval elapses, shouldSkipSync is polled again. It
  // returns true, so the entry is discarded (confirmed already applied).
  env.addTimelineComments('beforeNextAction', [
    'retry interval elapses — shouldSkipSync confirms mutation was applied, entry cleared',
  ]);
  await advanceTime(5_000);
  await flushAllTimers();

  expect(shouldSkipSync).toHaveBeenCalledTimes(1);
  expect(skipCheckEnqueuedAt).toBe(TEST_INITIAL_TIME);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                                          |
    0     | "value:1 sync:none pending:0"               | ui-initialized
    .     | "value:2 sync:none pending:0"               | ui-changed
    .     | "value:2 sync:pending pending:1"            | ui-changed
    .     | "value:2 sync:pending pending:1"            | offline:updateValue queued
    .     | "value:2 sync:pending pending:1"            | -- go online — execute fails ambiguously, entry moves to needs-confirmation
    .     | "value:2 sync:syncing pending:1"            | ui-changed
    .     | "value:2 sync:syncing pending:1"            | offline:updateValue replay-started
    .     | "value:2 sync:needs-confirmation pending:1" | ui-changed
    10ms  | "value:2 sync:needs-confirmation pending:1" | -- retry interval elapses — shouldSkipSync confirms mutation was applied, entry cleared
    .     | "value:2 sync:needs-confirmation pending:1" | 🔴 >fetch-started
    810ms | "value:2 sync:needs-confirmation pending:1" | 🔴 <fetch-finished (value: 1)
    5s    | "value:2 sync:syncing pending:1"            | ui-changed
    .     | "value:1 sync:none pending:0"               | ui-changed
    5.01s | "value:1 sync:none pending:0"               | 🟠 >fetch-started
    5.81s | "value:1 sync:none pending:0"               | 🟠 <fetch-finished (value: 1)
    "
  `);
});
