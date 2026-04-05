import { rc_number, rc_object, rc_string } from 'runcheck';

import type {
  CollectionOfflineOperationDefinition,
  DocumentOfflineOperationDefinition,
  ListQueryOfflineOperationDefinition,
} from '../../src/main';
import type { ListQueryParams } from '../mocks/listQueryStoreTestEnv';
import { parsePersistedObject, toRecord } from './offlineTestShared';

export type CreateUserOperations = {
  createUser: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { name: string },
    unknown,
    { id: string; name: string }
  >;
};

export type UpdateValueOperations = {
  updateValue: DocumentOfflineOperationDefinition<
    { value: number },
    { input: { value: number } }
  >;
};

export type UpdateValueExecuteContext = Parameters<
  UpdateValueOperations['updateValue']['execute']
>[0];

export type UpdateValueConflictOperations = {
  updateValue: DocumentOfflineOperationDefinition<
    { value: number },
    { input: { value: number }; conflict: { reason: string } }
  >;
};

export type PatchUserOperations = {
  patchUserName: ListQueryOfflineOperationDefinition<
    { id: number; name: string },
    ListQueryParams,
    string,
    { itemId: string; name: string },
    unknown
  >;
};

export type CreateListQueryUserOperations = {
  createUser: ListQueryOfflineOperationDefinition<
    { id: number; name: string },
    ListQueryParams,
    string,
    { name: string },
    unknown,
    { id: number; name: string }
  >;
};

export const userPatchSchema = rc_object({
  itemId: rc_string,
  name: rc_string,
});
export const deleteItemInputSchema = rc_object({ itemId: rc_string });
export const userRowSchema = rc_object({ id: rc_number, name: rc_string });

type DocumentReplayEnv = {
  serverMock: {
    delayedSetData: (
      value: number,
      options?: { durationMs?: number },
    ) => Promise<void>;
  };
};

export async function replayDocumentValueWithDelay(
  env: DocumentReplayEnv,
  input: { value: number },
) {
  await env.serverMock.delayedSetData(input.value);
  return input;
}

type CollectionReplayEnv = {
  serverTable: {
    delayedSetItem: (
      itemId: string,
      data: { name: string },
      options?: { durationMs?: number },
    ) => Promise<void>;
    delayedUpdateItem: (
      itemId: string,
      data: Partial<{ name: string }>,
      options?: { durationMs?: number },
    ) => Promise<void>;
    delayedRemoveItem: (
      itemId: string,
      options?: { durationMs?: number },
    ) => Promise<void>;
  };
};

export async function replayCollectionRenameWithDelay(
  env: CollectionReplayEnv,
  input: { id: string; name: string },
) {
  await env.serverTable.delayedUpdateItem(input.id, { name: input.name });
  return { value: { name: input.name } };
}

export async function replayCollectionCreateWithDelay(
  env: CollectionReplayEnv,
  result: { id: string; name: string },
) {
  await env.serverTable.delayedSetItem(result.id, { name: result.name });
  return result;
}

export async function replayBatchCollectionCreateWithDelay(
  env: CollectionReplayEnv,
  results: { id: string; name: string }[],
) {
  for (const result of results) {
    await replayCollectionCreateWithDelay(env, result);
  }
  return results;
}

type ListQueryReplayEnv = {
  serverTable: {
    delayedSetItem: (
      itemId: string,
      data: { id: number; name: string },
      options?: { durationMs?: number },
    ) => Promise<void>;
    delayedUpdateItem: (
      itemId: string,
      data: Partial<{ id: number; name: string }>,
      options?: { durationMs?: number },
    ) => Promise<void>;
    delayedRemoveItem: (
      itemId: string,
      options?: { durationMs?: number },
    ) => Promise<void>;
  };
};

export async function replayListQueryPatchWithDelay(
  env: ListQueryReplayEnv,
  input: { itemId: string; name: string },
) {
  await env.serverTable.delayedUpdateItem(input.itemId, { name: input.name });
  return { name: input.name };
}

export async function replayListQueryCreateWithDelay(
  env: ListQueryReplayEnv,
  result: { id: number; name: string },
) {
  await env.serverTable.delayedSetItem(`users||${result.id}`, result);
  return result;
}

export async function replayBatchListQueryCreateWithDelay(
  env: ListQueryReplayEnv,
  results: { id: number; name: string }[],
) {
  for (const result of results) {
    await replayListQueryCreateWithDelay(env, result);
  }
  return results;
}

export async function replayListQueryDeleteWithDelay(
  env: ListQueryReplayEnv,
  input: { itemId: string },
) {
  await env.serverTable.delayedRemoveItem(input.itemId);
}

export function getLocalStorageKeys(): string[] {
  const keys: string[] = [];

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key) keys.push(key);
  }

  return keys.sort();
}

export function getOfflineQueueEntries(
  sessionKey: string,
  storeName: string,
): Array<Record<string, unknown>> {
  return getLocalStorageKeys()
    .filter((key) => key.startsWith(`tsdf.${sessionKey}.${storeName}.oq.`))
    .map((key) => {
      const persistedValue = localStorage.getItem(key);
      if (!persistedValue) {
        throw new Error(`Missing persisted queue entry for "${key}"`);
      }

      return parsePersistedObject(persistedValue);
    });
}

export function getOfflineQueueEntryData(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  return toRecord(
    'd' in entry ? entry.d : entry.data,
    'Expected persisted queue data to be an object',
  );
}
