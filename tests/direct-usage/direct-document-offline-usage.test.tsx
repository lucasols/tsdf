import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  createDocumentStore,
  type DocumentOfflineOperationDefinition,
  type DocumentStore,
  getGlobalOfflineEntities,
  getGlobalOfflineStatus,
  localPersistentStorage,
} from '../../src/main';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';

const docSchema = rc_object({ value: rc_number, label: rc_string });
const docInputSchema = rc_object({ value: rc_number });
const docPatchInputSchema = rc_object({
  value: rc_number.optional(),
  label: rc_string.optional(),
});
const FETCH_DELAY_MS = 30;

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

type DocState = { value: number; label: string };

type SetValueDocumentOperations = {
  setValue: DocumentOfflineOperationDefinition<
    DocState,
    { value: number },
    unknown,
    { value: number }
  >;
};

type TypedDocumentStore = DocumentStore<DocState, SetValueDocumentOperations>;

type DocumentOfflineOption = NonNullable<
  Parameters<TypedDocumentStore['performMutation']>[0]['offline']
>;

const validDocumentOfflineOption_: DocumentOfflineOption = {
  operation: 'setValue',
  input: { value: 2 },
};
const invalidDocumentOfflineInput_: DocumentOfflineOption | undefined =
  // @ts-expect-error invalid document offline input must be rejected
  { operation: 'setValue', input: { wrong: 2 } };

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

test('direct document store offline public api works and stays strongly typed', async () => {
  const network = createOfflineNetworkMock();
  const sessionKey = 'direct-document-offline-session';
  network.install();

  let documentState: DocState = { value: 1, label: 'server' };
  const documentStore = createDocumentStore<
    DocState,
    SetValueDocumentOperations
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
      storeName: 'direct-document-offline',
      adapter: localPersistentStorage,
      schema: docSchema,
      offlineMode: {
        network: network.config,
        operations: {
          setValue: {
            inputSchema: docInputSchema,
            execute: ({ input }) => {
              documentState = {
                value: input.value,
                label: `doc:${input.value}`,
              };
              documentStore.updateState((draft) => {
                draft.value = input.value;
                draft.label = `doc:${input.value}`;
              });
              return input;
            },
          },
        },
      },
    },
  });

  const documentHook = renderHook(() => documentStore.useDocument());
  await flushAllTimers();

  expect(documentHook.result.current.data).toMatchInlineSnapshot(`
    label: 'server'
    value: 1
  `);
  expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
    effectiveMode: 'online',
    effectiveOffline: false,
  });

  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  await act(async () => {
    await documentStore.performMutation({
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
  await act(async () => {
    await Promise.resolve();
  });

  expect(documentStore.getOfflineConflicts()).toMatchInlineSnapshot(`[]`);
  await documentStore.resolveOfflineConflict('missing', { resolution: 'noop' });
  expect(pick(documentHook.result.current, ['data', 'status']))
    .toMatchInlineSnapshot(`
      data: { label: 'doc:2', value: 2 }
      status: 'success'
    `);
  expect(documentStore.getOfflineEntities()).toMatchObject([
    { entityKey: 'document', pendingMutations: 1, storeType: 'document' },
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
    await vi.advanceTimersByTimeAsync(250);
    await vi.runAllTimersAsync();
  });

  expect(documentStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getGlobalOfflineEntities(sessionKey)).toMatchInlineSnapshot(`[]`);
  expect(documentHook.result.current.isPendingOfflineSync).toBe(false);
  expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
    effectiveMode: 'online',
    effectiveOffline: false,
    network: { active: false, enabled: true },
  });
});

type PatchDocInput = { value: number | undefined; label: string | undefined };

type PatchDocumentOperations = {
  patchDoc: DocumentOfflineOperationDefinition<
    DocState,
    PatchDocInput,
    unknown,
    DocState
  >;
};

test('document offline accumulation merges pending mutations into a single queued operation', async () => {
  const network = createOfflineNetworkMock();
  const sessionKey = 'direct-document-offline-accumulation-session';
  network.install();

  let documentState: DocState = { value: 1, label: 'server' };
  const execute = vi.fn(({ input }: { input: PatchDocInput }) => {
    documentState = {
      value: input.value ?? documentState.value,
      label: input.label ?? documentState.label,
    };
    documentStore.updateState((draft) => {
      if (input.value !== undefined) {
        draft.value = input.value;
      }
      if (input.label !== undefined) {
        draft.label = input.label;
      }
    });
    return { ...documentState };
  });

  const documentStore = createDocumentStore<DocState, PatchDocumentOperations>({
    id: 'direct-document-offline-accumulation',
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
      storeName: 'direct-document-offline-accumulation',
      adapter: localPersistentStorage,
      schema: docSchema,
      offlineMode: {
        network: network.config,
        operations: {
          patchDoc: {
            inputSchema: docPatchInputSchema,
            accumulation: {
              mergeInput: ({ existingInput, incomingInput }) => ({
                value: incomingInput.value ?? existingInput.value,
                label: incomingInput.label ?? existingInput.label,
              }),
            },
            execute,
          },
        },
      },
    },
  });

  const documentHook = renderHook(() => documentStore.useDocument());
  await flushAllTimers();

  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  await act(async () => {
    await documentStore.performMutation({
      optimisticUpdate: () => {
        documentStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: () => Promise.resolve({ value: 2 }),
      offline: { operation: 'patchDoc', input: { value: 2, label: undefined } },
    });
  });

  await act(async () => {
    await documentStore.performMutation({
      optimisticUpdate: () => {
        documentStore.updateState((draft) => {
          draft.label = 'offline';
        });
      },
      mutation: () => Promise.resolve({ label: 'offline' }),
      offline: {
        operation: 'patchDoc',
        input: { value: undefined, label: 'offline' },
      },
    });
  });
  await Promise.resolve();

  expect(documentStore.getOfflineEntities()).toMatchObject([
    { entityKey: 'document', pendingMutations: 1, storeType: 'document' },
  ]);

  await act(async () => {
    network.goOnline();
    await vi.advanceTimersByTimeAsync(250);
    await vi.runAllTimersAsync();
  });

  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0]?.[0]?.input).toMatchInlineSnapshot(`
    label: 'offline'
    value: 2
  `);
  expect(documentState).toMatchInlineSnapshot(`
    label: 'offline'
    value: 2
  `);
  documentHook.unmount();
});

test('document offline accumulation rejects invalid merged input without corrupting the queued entry', async () => {
  const network = createOfflineNetworkMock();
  const sessionKey = 'direct-document-offline-invalid-accumulation-session';
  network.install();

  let documentState: DocState = { value: 1, label: 'server' };
  const invalidAccumulationSchema = {
    '~standard': {
      validate: (value: unknown) => {
        if (typeof value !== 'object' || value === null) {
          return { issues: [{ message: 'Invalid input' }] as const };
        }

        const nextValue = Reflect.get(value, 'value');
        const nextLabel = Reflect.get(value, 'label');
        const parsedValue =
          typeof nextValue === 'number' ? nextValue : undefined;
        const parsedLabel =
          typeof nextLabel === 'string' ? nextLabel : undefined;

        if (parsedValue === 2 && parsedLabel === 'invalid') {
          return {
            issues: [{ message: 'Invalid accumulated input' }] as const,
          };
        }

        return { value: { value: parsedValue, label: parsedLabel } } as const;
      },
    },
  };
  const execute = vi.fn(({ input }: { input: PatchDocInput }) => {
    documentState = {
      value: input.value ?? documentState.value,
      label: input.label ?? documentState.label,
    };
    documentStore.updateState((draft) => {
      if (input.value !== undefined) {
        draft.value = input.value;
      }
      if (input.label !== undefined) {
        draft.label = input.label;
      }
    });
    return { ...documentState };
  });

  const documentStore = createDocumentStore<DocState, PatchDocumentOperations>({
    id: 'direct-document-offline-invalid-accumulation',
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
      storeName: 'direct-document-offline-invalid-accumulation',
      adapter: localPersistentStorage,
      schema: docSchema,
      offlineMode: {
        network: network.config,
        operations: {
          patchDoc: {
            inputSchema: invalidAccumulationSchema,
            accumulation: {
              mergeInput: ({ existingInput, incomingInput }) => ({
                value: incomingInput.value ?? existingInput.value,
                label: incomingInput.label ?? existingInput.label,
              }),
            },
            execute,
          },
        },
      },
    },
  });

  const documentHook = renderHook(() => documentStore.useDocument());
  await flushAllTimers();

  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  await documentStore.performMutation({
    mutation: () => Promise.resolve({ value: 2 }),
    offline: { operation: 'patchDoc', input: { value: 2, label: undefined } },
  });
  const secondResult = await documentStore.performMutation({
    mutation: () => Promise.resolve({ label: 'invalid' }),
    offline: {
      operation: 'patchDoc',
      input: { value: undefined, label: 'invalid' },
    },
  });

  expect(secondResult.ok).toBe(false);
  expect(documentStore.getOfflineEntities()).toMatchObject([
    { entityKey: 'document', pendingMutations: 1, storeType: 'document' },
  ]);

  await act(async () => {
    network.goOnline();
    await vi.advanceTimersByTimeAsync(250);
    await vi.runAllTimersAsync();
  });

  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0]?.[0]?.input).toMatchInlineSnapshot(`
    value: 2
  `);
  documentHook.unmount();
});

test('document offline mutations without accumulation stay as separate queued operations', async () => {
  const network = createOfflineNetworkMock();
  const sessionKey = 'direct-document-offline-no-accumulation-session';
  network.install();

  let documentState: DocState = { value: 1, label: 'server' };
  const documentStore = createDocumentStore<
    DocState,
    SetValueDocumentOperations
  >({
    id: 'direct-document-offline-no-accumulation',
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
      storeName: 'direct-document-offline-no-accumulation',
      adapter: localPersistentStorage,
      schema: docSchema,
      offlineMode: {
        network: network.config,
        operations: {
          setValue: {
            inputSchema: docInputSchema,
            execute: ({ input }) => {
              documentState = {
                value: input.value,
                label: `doc:${input.value}`,
              };
              documentStore.updateState((draft) => {
                draft.value = input.value;
                draft.label = `doc:${input.value}`;
              });
              return input;
            },
          },
        },
      },
    },
  });

  renderHook(() => documentStore.useDocument());
  await flushAllTimers();

  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  await documentStore.performMutation({
    mutation: () => Promise.resolve({ value: 2 }),
    offline: { operation: 'setValue', input: { value: 2 } },
  });
  await documentStore.performMutation({
    mutation: () => Promise.resolve({ value: 3 }),
    offline: { operation: 'setValue', input: { value: 3 } },
  });

  expect(documentStore.getOfflineEntities()).toMatchObject([
    { entityKey: 'document', pendingMutations: 2, storeType: 'document' },
  ]);
});
