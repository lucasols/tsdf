import { test, expect } from 'vitest';
import {
  createDocumentStore,
  type DocumentOfflineOperationDefinition,
} from '../../src/main';
import { docMutationInputSchema, docSchema } from './offlineTestShared';

type DocState = { value: number };
type UpdateValueOperations = {
  updateValue: DocumentOfflineOperationDefinition<
    DocState,
    { value: number },
    unknown,
    { value: number }
  >;
};

const typedDocumentStore_ = createDocumentStore<
  DocState,
  UpdateValueOperations
>({
  id: 'offline-typing-doc',
  getSessionKey: () => 'offline-typing-session',
  fetchFn: () => Promise.resolve({ value: 1 }),
  errorNormalizer: (exception) => ({
    code: 500,
    id: 'fetch-error',
    message: exception.message,
  }),
  lowPriorityThrottleMs: 1,
  baseCoalescingWindowMs: 1,
  blockWindowClose: null,
  persistentStorage: {
    storeName: 'offline-typing-doc',
    backend: 'localStorage',
    schema: docSchema,
    offlineMode: {
      operations: {
        updateValue: {
          inputSchema: docMutationInputSchema,
          accumulation: {
            mergeInput: ({ existingInput, incomingInput }) => ({
              value: existingInput.value + incomingInput.value,
            }),
          },
          execute: ({ input }) => input,
        },
      },
    },
  },
});

const invalidPartialConflictHandling_: DocumentOfflineOperationDefinition<
  DocState,
  { value: number },
  unknown,
  { value: number }
> = {
  inputSchema: docMutationInputSchema,
  execute: ({ input }: { input: { value: number } }) => input,
  // @ts-expect-error conflictHandling must provide detectConflict and resolveConflict together
  conflictHandling: { detectConflict: () => false },
};

const invalidPartialTempEntity_: DocumentOfflineOperationDefinition<
  DocState,
  { value: number },
  unknown,
  { value: number }
> = {
  inputSchema: docMutationInputSchema,
  execute: ({ input }: { input: { value: number } }) => input,
  // @ts-expect-error tempEntity must provide createTempId, buildPendingEntity, and reconcileServerEntity together
  tempEntity: { createTempId: () => 'temp:1' },
};

type DocumentMutationOptions = Parameters<
  typeof typedDocumentStore_.performMutation
>[0];

const validOfflineDescriptor: NonNullable<DocumentMutationOptions['offline']> =
  { operation: 'updateValue', input: { value: 3 } };

const invalidOfflineInput_: NonNullable<DocumentMutationOptions['offline']> = {
  operation: 'updateValue',
  // @ts-expect-error invalid offline input shape must be rejected
  input: { wrong: 3 },
};

const invalidOfflineOperation_: NonNullable<
  DocumentMutationOptions['offline']
> = {
  // @ts-expect-error invalid offline operation name must be rejected
  operation: 'deleteValue',
  input: { value: 3 },
};

test('offline mutation descriptors stay strongly typed', () => {
  expect(validOfflineDescriptor.operation).toBe('updateValue');
  expect(validOfflineDescriptor.input).toMatchInlineSnapshot(`
    value: 3
  `);
  expect(invalidPartialConflictHandling_).toBeDefined();
  expect(invalidPartialTempEntity_).toBeDefined();
  expect(true).toBe(true);
});
