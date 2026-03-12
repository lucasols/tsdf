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
    { value: number },
    unknown,
    { value: number }
  >;
};

type TypedDocumentStore = DocumentStore<DocState, UpdateValueOperations>;

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
  expect(true).toBe(true);
});
