import { test, expect } from 'vitest';
import {
  type DocumentOfflineOperationDefinition,
  type DocumentStore,
} from '../../src/main';
import { docMutationInputSchema } from './offlineTestShared';

type DocState = { value: number };
type UpdateValueOperations = {
  updateValue: DocumentOfflineOperationDefinition<
    DocState,
    { input: { value: number }; result: { value: number } }
  >;
};

type TypedDocumentStore = DocumentStore<DocState, UpdateValueOperations>;

const invalidPartialConflictHandling_: DocumentOfflineOperationDefinition<
  DocState,
  { input: { value: number }; result: { value: number } }
> = {
  inputSchema: docMutationInputSchema,
  execute: ({
    input,
    enqueuedAt,
  }: {
    input: { value: number };
    enqueuedAt: number;
  }) => ({ value: input.value + enqueuedAt - enqueuedAt }),
  // @ts-expect-error conflictHandling must provide detectConflict and resolveConflict together
  conflictHandling: { detectConflict: () => false },
};

const invalidPartialTempEntity_: DocumentOfflineOperationDefinition<
  DocState,
  { input: { value: number }; result: { value: number } }
> = {
  inputSchema: docMutationInputSchema,
  execute: ({
    input,
    enqueuedAt,
  }: {
    input: { value: number };
    enqueuedAt: number;
  }) => ({ value: input.value + enqueuedAt - enqueuedAt }),
  // @ts-expect-error tempEntity must provide createTempId, buildPendingEntity, and reconcileServerEntity together
  tempEntity: { createTempId: () => 'temp:1' },
};

const validConflictHandling_ = {
  inputSchema: docMutationInputSchema,
  execute: ({
    input,
    enqueuedAt,
  }: {
    input: { value: number };
    enqueuedAt: number;
  }) => ({ value: input.value + enqueuedAt - enqueuedAt }),
  conflictHandling: {
    detectConflict: ({
      input,
      enqueuedAt,
    }: {
      input: { value: number };
      enqueuedAt: number;
    }) => (input.value === enqueuedAt ? { reason: 'conflict' } : false),
    resolveConflict: ({
      input,
      conflict,
      resolution,
      enqueuedAt,
    }: {
      input: { value: number };
      conflict: unknown;
      resolution: unknown;
      enqueuedAt: number;
    }) => {
      void input;
      void conflict;
      void resolution;
      void enqueuedAt;
      return undefined;
    },
  },
} satisfies DocumentOfflineOperationDefinition<
  DocState,
  {
    input: { value: number };
    conflict: { reason: string };
    result: { value: number };
  }
>;

type DocumentMutationOptions = Parameters<
  TypedDocumentStore['performMutation']
>[0];

const validOfflineDescriptor_: NonNullable<DocumentMutationOptions['offline']> =
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
  expect(validConflictHandling_).toBeDefined();
  expect(true).toBe(true);
});
