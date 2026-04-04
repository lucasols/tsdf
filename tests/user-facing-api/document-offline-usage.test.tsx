import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

import {
  createOfflineSession,
  createDocumentStore,
  type DefineDocumentOfflineOperations,
  type DefineOfflineOperation,
  getGlobalOfflineEntities,
  getGlobalOfflineStatus,
} from '../../src/main';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';

const docSchema = rc_object({ value: rc_number, label: rc_string });
const docConflictSchema = rc_object({ reason: rc_string });
const setValueInputSchema = rc_object({ value: rc_number });
const conflictResolutionSchema = z.object({ value: z.number() });
const patchDocAccumulationZodSchema = z
  .object({ value: z.number().optional(), label: z.string().optional() })
  .superRefine((input, ctx) => {
    if (input.value === 4 && input.label === 'invalid') {
      ctx.addIssue({ code: 'custom', message: 'Invalid accumulated input' });
    }
  })
  .transform((value) => ({ value: value.value, label: value.label }));
type PatchDocInput = { value: number | undefined; label: string | undefined };
const patchDocAccumulationSchema = patchDocAccumulationZodSchema;
const FETCH_DELAY_MS = 30;

type ValueInput = { value: number };
type ConflictData = { reason: string };

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  localStorage.clear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  localStorage.clear();
});

const invalidDocumentTempEntityOperation: DirectDocumentOfflineOperations['setValue'] =
  {
    inputSchema: setValueInputSchema,
    execute: ({ input }) => input,
    // @ts-expect-error - document offline operations do not support tempEntity
    tempEntity: {
      buildPendingEntity: () => ({ value: 1, label: 'pending' }),
      reconcileServerEntity: () => ({
        finalPayload: 'document',
        finalData: { value: 1, label: 'done' },
      }),
    },
  };

void invalidDocumentTempEntityOperation;

type DocState = { value: number; label: string };

type RuntimeOnlyDocumentOfflineOperations = DefineDocumentOfflineOperations<
  DocState,
  Record<never, never>
>;

test('direct document store runtime offline controls public api', async () => {
  const network = createOfflineNetworkMock(false);
  const sessionKey = 'direct-document-runtime-controls';
  network.install();
  const offlineSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: { network: network.config },
  });

  const documentStore_ = createDocumentStore<
    DocState,
    RuntimeOnlyDocumentOfflineOperations
  >({
    id: 'direct-document-runtime-controls',
    getSessionKey: () => sessionKey,
    fetchFn: () => Promise.resolve({ value: 1, label: 'server' }),
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs: 5,
    baseCoalescingWindowMs: 10,
    blockWindowClose: null,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { session: offlineSession },
    },
  });

  await flushAllTimers();

  expect(offlineSession.getOfflineRuntimeConfig()).toMatchInlineSnapshot(`
    mutationQueueing: { network: 'allow', outage: 'allow' }
    network: { enabled: '✅' }
    outage: { enabled: '❌' }
  `);
  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    isLeader: '✅'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'direct-document-runtime-controls'
    updatedAt: 1735689600000
  `);

  offlineSession.setOfflineRuntimeConfig({
    network: { enabled: false },
    mutationQueueing: { network: 'disallow' },
  });
  await Promise.resolve();

  expect(offlineSession.getOfflineRuntimeConfig()).toMatchInlineSnapshot(`
    mutationQueueing: { network: 'disallow', outage: 'allow' }
    network: { enabled: '❌' }
    outage: { enabled: '❌' }
  `);
  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'normal'
    effectiveOffline: '❌'
    isLeader: '✅'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '✅', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'direct-document-runtime-controls'
    updatedAt: 1735689602000
  `);

  expect(() => {
    offlineSession.setOfflineRuntimeConfig({ outage: { enabled: true } });
  }).toThrowErrorMatchingInlineSnapshot(
    `
    Error#:
      message: 'Offline runtime control "outage.enabled" is unavailable for session "direct-document-runtime-controls" because offlineSession.outage was not configured'
      name: 'Error'
    `,
  );

  offlineSession.resetOfflineRuntimeConfig();
  await Promise.resolve();

  expect(offlineSession.getOfflineRuntimeConfig()).toMatchInlineSnapshot(`
    mutationQueueing: { network: 'allow', outage: 'allow' }
    network: { enabled: '✅' }
    outage: { enabled: '❌' }
  `);
  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    isLeader: '✅'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'direct-document-runtime-controls'
    updatedAt: 1735689602000
  `);
});

type DirectDocumentOfflineOperations = DefineDocumentOfflineOperations<
  DocState,
  {
    setValue: DefineOfflineOperation<ValueInput>;
    patchDoc: DefineOfflineOperation<PatchDocInput>;
    skipSyncValue: DefineOfflineOperation<
      ValueInput,
      unknown,
      unknown,
      DocState
    >;
    conflictValue: DefineOfflineOperation<
      ValueInput,
      ConflictData,
      unknown,
      DocState
    >;
  }
>;

// tests using the document store directly without test envs to verify the public API usage
test('direct document store offline public api', async () => {
  const network = createOfflineNetworkMock();
  const sessionKey = 'direct-document-offline-session';
  network.install();
  const offlineSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: {
      network: network.config,
      mutationQueueing: { network: 'allow', outage: 'allow' },
    },
  });

  let documentState: DocState = { value: 1, label: 'server' };
  const skipSyncReplayOrder: string[] = [];
  const conflictReplayOrder: string[] = [];

  const documentStore = createDocumentStore<
    DocState,
    DirectDocumentOfflineOperations
  >({
    id: 'direct-document-offline',
    getSessionKey: () => sessionKey,
    fetchFn: async () => {
      await delay(FETCH_DELAY_MS);
      return { ...documentState };
    },
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs: 5,
    baseCoalescingWindowMs: 10,
    blockWindowClose: null,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        session: offlineSession,
        operations: {
          setValue: {
            inputSchema: setValueInputSchema,
            execute: ({ input }) => {
              documentState = {
                value: input.value,
                label: `doc:${input.value}`,
              };
            },
          },
          patchDoc: {
            inputSchema: patchDocAccumulationSchema,
            accumulation: {
              mergeInput: ({ existingInput, incomingInput }) => ({
                value: incomingInput.value ?? existingInput.value,
                label: incomingInput.label ?? existingInput.label,
              }),
            },
            execute: ({ input }) => {
              documentState = {
                value: input.value ?? documentState.value,
                label: input.label ?? documentState.label,
              };
            },
          },
          skipSyncValue: {
            inputSchema: setValueInputSchema,
            getServerSnapshot: () => {
              skipSyncReplayOrder.push('getServerSnapshot');
              return { ...documentState };
            },
            execute: ({ input }) => {
              throw new Error(`dispatch failed after send ${input.value}`);
            },
            shouldSkipSync: ({
              input,
              enqueuedAt,
              updatedAt,
              serverSnapshot,
            }) => {
              skipSyncReplayOrder.push('shouldSkipSync');
              expect(input.value).toBe(5);
              expect(typeof input.value).toBe('number');
              expect(updatedAt).toBeGreaterThanOrEqual(enqueuedAt);
              expect(serverSnapshot).toEqual(documentState);
              return true;
            },
          },
          conflictValue: {
            inputSchema: setValueInputSchema,
            getServerSnapshot: () => {
              conflictReplayOrder.push('getServerSnapshot');
              return { ...documentState };
            },
            conflictHandling: {
              schema: docConflictSchema,
              detectConflict: ({
                input,
                enqueuedAt,
                updatedAt,
                serverSnapshot,
              }) => {
                conflictReplayOrder.push('detectConflict');
                expect(updatedAt).toBeGreaterThanOrEqual(enqueuedAt);
                expect(serverSnapshot).toEqual(documentState);
                if (input.value !== 6) return false;

                return { reason: 'stale-server-value' };
              },
              resolveConflict: ({
                conflict,
                resolution,
                input,
                enqueuedAt,
                updatedAt,
              }) => {
                void input;
                expect(conflict.reason).toBe('stale-server-value');
                expect(updatedAt).toBeGreaterThanOrEqual(enqueuedAt);
                const parsedResolution =
                  conflictResolutionSchema.parse(resolution);

                return {
                  requeue: { input: { value: parsedResolution.value } },
                };
              },
            },
            execute: ({ input }) => {
              documentState = {
                value: input.value,
                label: `resolved:${input.value}`,
              };
              documentStore.updateState((draft) => {
                draft.value = input.value;
                draft.label = `resolved:${input.value}`;
              });
            },
          },
        },
      },
    },
  });

  const documentHook = renderHook(() => documentStore.useDocument());
  await flushAllTimers();

  expect(pick(documentHook.result.current, ['data', 'status', 'pendingSync']))
    .toMatchInlineSnapshot(`
      data: { label: 'server', value: 1 }
      pendingSync: '❌'
      status: 'success'
    `);

  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'normal'
    effectiveOffline: '❌'
    isLeader: '✅'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '❌', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'direct-document-offline-session'
    updatedAt: 1735689600010
  `);

  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  const setValueResult = await act(async () => {
    return documentStore.performMutation({
      optimisticUpdate: () => {
        documentStore.updateState((draft) => {
          draft.value = 2;
          draft.label = 'doc:2';
        });
      },
      mutation: () => Promise.resolve({ value: 2 }),
      offline: { operation: 'setValue', input: { value: 2 } },
    });
  });

  assert(setValueResult.ok);
  expect(setValueResult.value).toMatchInlineSnapshot(`kind: 'queued'`);

  const patchDocResult = await act(async () => {
    return documentStore.performMutation({
      optimisticUpdate: () => {
        documentStore.updateState((draft) => {
          draft.value = 3;
          draft.label = 'offline label';
        });
      },
      mutation: () => Promise.resolve({ value: 3, label: 'offline label' }),
      offline: {
        operation: 'patchDoc',
        input: { value: 3, label: 'offline label' },
      },
    });
  });

  assert(patchDocResult.ok);
  expect(patchDocResult.value).toMatchInlineSnapshot(`kind: 'queued'`);

  const invalidAccumulationResult = await act(async () => {
    return documentStore.performMutation({
      mutation: () => Promise.resolve({ value: 4, label: 'invalid' }),
      offline: { operation: 'patchDoc', input: { value: 4, label: 'invalid' } },
    });
  });

  assert(!invalidAccumulationResult.ok);
  expect(invalidAccumulationResult.error).toMatchInlineSnapshot(`
    code: 500
    id: 'fetch-error'
    message: 'Invalid offline operation input for "patchDoc"'
  `);

  await act(async () => {
    await documentStore.performMutation({
      optimisticUpdate: () => {
        documentStore.updateState((draft) => {
          draft.value = 4;
        });
      },
      mutation: () => Promise.resolve({ value: 4 }),
      offline: { operation: 'patchDoc', input: { value: 4, label: undefined } },
    });
  });

  await act(async () => {
    await documentStore.performMutation({
      optimisticUpdate: () => {
        documentStore.updateState((draft) => {
          draft.value = 5;
          draft.label = 'confirm:5';
        });
      },
      mutation: () => Promise.resolve({ value: 5 }),
      offline: { operation: 'skipSyncValue', input: { value: 5 } },
    });
  });

  await act(async () => {
    await documentStore.performMutation({
      optimisticUpdate: () => {
        documentStore.updateState((draft) => {
          draft.value = 6;
          draft.label = 'conflict:6';
        });
      },
      mutation: () => Promise.resolve({ value: 6 }),
      offline: { operation: 'conflictValue', input: { value: 6 } },
    });
  });
  await Promise.resolve();

  expect(documentStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  await documentStore.resolveOfflineResolution('missing', {
    resolution: 'noop',
  });
  expect(pick(documentHook.result.current, ['data', 'status', 'pendingSync']))
    .toMatchInlineSnapshot(`
      data: { label: 'conflict:6', value: 6 }
      pendingSync: '✅'
      status: 'success'
    `);

  expect(documentStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689601040
      entityKey: 'document'
      entityKind: 'document'
      id: 'direct-document-offline-session:direct-document-offline:document'
      pendingMutations: 4
      requiresResolution: '❌'
      sessionKey: 'direct-document-offline-session'
      storeName: 'direct-document-offline'
      storeType: 'document'
      syncState: 'pending'
      updatedAt: 1735689601040
  `);

  expect(getGlobalOfflineEntities(sessionKey)).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689601040
      entityKey: 'document'
      entityKind: 'document'
      id: 'direct-document-offline-session:direct-document-offline:document'
      pendingMutations: 4
      requiresResolution: '❌'
      sessionKey: 'direct-document-offline-session'
      storeName: 'direct-document-offline'
      storeType: 'document'
      syncState: 'pending'
      updatedAt: 1735689601040
  `);

  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'offline'
    effectiveOffline: '✅'
    isLeader: '✅'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'direct-document-offline-session'
    updatedAt: 1735689601040
  `);

  await act(async () => {
    network.goOnline();
    await advanceTime(250);
    await flushAllTimers();
  });

  expect(documentHook.result.current.status).toBe('success');
  expect(documentHook.result.current.pendingSync).toBe(false);

  const [conflict] = documentStore.getOfflineResolutions();
  if (!conflict || conflict.kind !== 'conflict') {
    throw new Error('Expected a conflict resolution');
  }

  expect({
    ...pick(conflict, [
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
    conflict: conflict.conflict,
  }).toMatchInlineSnapshot(`
    blockedByResolutionIds: []
    blockedResolutionCount: 0
    childResolutionCount: 0
    childResolutionIds: []
    conflict: { reason: 'stale-server-value' }
    createdAt: 1735689606040
    enqueuedAt: 1735689601040
    entityRefs:
      - { entityKey: 'document', entityKind: 'document' }
    input: { value: 6 }
    kind: 'conflict'
    operation: 'conflictValue'
    sessionKey: 'direct-document-offline-session'
    storeName: 'direct-document-offline'
    storeType: 'document'
    updatedAt: 1735689606040
  `);

  expect(documentStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689606040
      entityKey: 'document'
      entityKind: 'document'
      id: 'direct-document-offline-session:direct-document-offline:document'
      pendingMutations: 0
      requiresResolution: '✅'
      sessionKey: 'direct-document-offline-session'
      storeName: 'direct-document-offline'
      storeType: 'document'
      syncState: 'resolution-required'
      updatedAt: 1735689606040
  `);
  expect(skipSyncReplayOrder).toMatchInlineSnapshot(
    `['getServerSnapshot', 'shouldSkipSync']`,
  );
  expect(conflictReplayOrder).toMatchInlineSnapshot(
    `['getServerSnapshot', 'detectConflict']`,
  );

  await act(async () => {
    await documentStore.resolveOfflineResolution(conflict.id, { value: 7 });
    await flushAllTimers();
  });

  expect(documentStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(documentStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getGlobalOfflineEntities(sessionKey)).toMatchInlineSnapshot(`[]`);
  expect(pick(documentHook.result.current, ['data', 'status', 'pendingSync']))
    .toMatchInlineSnapshot(`
      data: { label: 'resolved:7', value: 7 }
      pendingSync: '❌'
      status: 'success'
    `);

  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    effectiveMode: 'normal'
    effectiveOffline: '❌'
    isLeader: '✅'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '❌', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'direct-document-offline-session'
    updatedAt: 1735689601050
  `);

  documentHook.unmount();
});
