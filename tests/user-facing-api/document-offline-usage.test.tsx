import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

import {
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

type DocState = { value: number; label: string };

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
      offlineMode: {
        network: network.config,
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
  expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
    effectiveMode: 'online',
    effectiveOffline: false,
  });

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

  const multiOperationResult = await act(async () => {
    return documentStore.performMutation({
      optimisticUpdate: () => {
        documentStore.updateState((draft) => {
          draft.value = 3;
          draft.label = 'offline label';
        });
      },
      mutation: () => Promise.resolve({ value: 3, label: 'offline label' }),
      offline: [
        { operation: 'setValue', input: { value: 3 } },
        {
          operation: 'patchDoc',
          input: { value: undefined, label: 'offline label' },
        },
      ],
    });
  });

  assert(multiOperationResult.ok);
  expect(multiOperationResult.value).toMatchInlineSnapshot(`kind: 'queued'`);

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

  expect(documentStore.getOfflineConflicts()).toMatchInlineSnapshot(`[]`);
  await documentStore.resolveOfflineConflict('missing', { resolution: 'noop' });
  expect(pick(documentHook.result.current, ['data', 'status', 'pendingSync']))
    .toMatchInlineSnapshot(`
      data: { label: 'conflict:6', value: 6 }
      pendingSync: '✅'
      status: 'success'
    `);
  expect(documentStore.getOfflineEntities()).toMatchObject([
    { entityKey: 'document', pendingMutations: 5, storeType: 'document' },
  ]);
  expect(getGlobalOfflineEntities(sessionKey)).toMatchObject([
    { storeName: 'direct-document-offline' },
  ]);
  expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
    effectiveMode: 'offline',
    effectiveOffline: true,
    network: { active: true, enabled: true },
  });

  await act(async () => {
    network.goOnline();
    await advanceTime(250);
    await flushAllTimers();
  });

  expect(documentHook.result.current.status).toBe('success');
  expect(documentHook.result.current.pendingSync).toBe(false);

  const [conflict] = documentStore.getOfflineConflicts();
  expect(conflict).toMatchObject({
    conflict: { reason: 'stale-server-value' },
    entityRefs: [{ entityKey: 'document', entityKind: 'document' }],
    input: { value: 6 },
    operation: 'conflictValue',
    sessionKey,
    storeName: 'direct-document-offline',
    storeType: 'document',
  });
  expect(documentStore.getOfflineEntities()).toMatchObject([
    {
      entityKey: 'document',
      hasConflict: true,
      pendingMutations: 0,
      storeType: 'document',
      syncState: 'conflict',
    },
  ]);
  expect(skipSyncReplayOrder).toMatchInlineSnapshot(
    `['getServerSnapshot', 'shouldSkipSync']`,
  );
  expect(conflictReplayOrder).toMatchInlineSnapshot(
    `['getServerSnapshot', 'detectConflict']`,
  );

  await act(async () => {
    await documentStore.resolveOfflineConflict(conflict!.id, { value: 7 });
    await flushAllTimers();
  });

  expect(documentStore.getOfflineConflicts()).toMatchInlineSnapshot(`[]`);
  expect(documentStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getGlobalOfflineEntities(sessionKey)).toMatchInlineSnapshot(`[]`);
  expect(pick(documentHook.result.current, ['data', 'status', 'pendingSync']))
    .toMatchInlineSnapshot(`
      data: { label: 'resolved:7', value: 7 }
      pendingSync: '❌'
      status: 'success'
    `);
  expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
    effectiveMode: 'online',
    effectiveOffline: false,
    network: { active: false, enabled: true },
  });

  documentHook.unmount();
});
