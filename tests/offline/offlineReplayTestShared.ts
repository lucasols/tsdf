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
export const userRowSchema = rc_object({ id: rc_number, name: rc_string });

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
