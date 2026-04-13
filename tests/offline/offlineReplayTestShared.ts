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

      return {
        ...parsePersistedObject(persistedValue),
        __sessionKey: sessionKey,
        __storeName: storeName,
      };
    });
}

function getSessionOfflineQueueEntries(
  sessionKey: string,
): Array<Record<string, unknown>> {
  const sessionPrefix = `tsdf.${sessionKey}.`;

  return getLocalStorageKeys()
    .filter((key) => key.startsWith(sessionPrefix) && key.includes('.oq.'))
    .map((key) => {
      const storeNameStart = sessionPrefix.length;
      const storeNameEnd = key.indexOf('.oq.', storeNameStart);
      if (storeNameEnd <= storeNameStart) {
        throw new Error(`Invalid offline queue key "${key}"`);
      }

      const storeName = key.slice(storeNameStart, storeNameEnd);
      const persistedValue = localStorage.getItem(key);
      if (!persistedValue) {
        throw new Error(`Missing persisted queue entry for "${key}"`);
      }

      return {
        ...parsePersistedObject(persistedValue),
        __sessionKey: sessionKey,
        __storeName: storeName,
      };
    });
}

export function getOfflineQueueEntryData(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  if ('d' in entry && typeof entry.d === 'object' && entry.d !== null) {
    return toRecord(entry.d, 'Expected persisted queue data to be an object');
  }

  if (
    'd' in entry &&
    typeof entry.d === 'string' &&
    'w' in entry &&
    typeof entry.w === 'string' &&
    'o' in entry &&
    typeof entry.o === 'string' &&
    'i' in entry &&
    'e' in entry &&
    Array.isArray(entry.e) &&
    'a' in entry &&
    typeof entry.a === 'number' &&
    'u' in entry &&
    typeof entry.u === 'number' &&
    's' in entry &&
    typeof entry.s === 'string'
  ) {
    const entityRefs = entry.e.map((ref) => {
      if (typeof ref !== 'string') {
        throw new Error('Expected compact queue entity ref to be a string');
      }

      const separatorIndex = ref.indexOf(':');
      if (separatorIndex <= 0) {
        throw new Error(`Invalid compact queue entity ref "${ref}"`);
      }

      const compactKind = ref.slice(0, separatorIndex);
      const entityKey = ref.slice(separatorIndex + 1);

      return {
        entityKey,
        entityKind:
          compactKind === 'd'
            ? 'document'
            : compactKind === 'i'
              ? 'item'
              : compactKind === 'q'
                ? 'query'
                : (() => {
                    throw new Error(
                      `Invalid compact queue entity kind "${compactKind}"`,
                    );
                  })(),
      };
    });

    const compactStoreType =
      entry.w === 'd'
        ? 'document'
        : entry.w === 'c'
          ? 'collection'
          : entry.w === 'l'
            ? 'listQuery'
            : (() => {
                throw new Error(
                  `Invalid compact queue store type "${entry.w}"`,
                );
              })();
    const compactSyncState =
      entry.s === 'p'
        ? 'pending'
        : entry.s === 's'
          ? 'syncing'
          : entry.s === 'n'
            ? 'needs-confirmation'
            : (() => {
                throw new Error(
                  `Invalid compact queue sync state "${entry.s}"`,
                );
              })();

    return {
      attempts: typeof entry.t === 'number' ? entry.t : 0,
      createdAt: entry.a,
      entityRefs,
      id: entry.d,
      input: entry.i,
      lastAttemptAt: typeof entry.l === 'number' ? entry.l : null,
      operation: entry.o,
      queueOrder: typeof entry.q === 'number' ? entry.q : entry.a,
      sessionKey: entry.__sessionKey,
      storeName: entry.__storeName,
      storeType: compactStoreType,
      syncState: compactSyncState,
      updatedAt: entry.u,
      ...(typeof entry.m === 'string'
        ? { lastError: { message: entry.m } }
        : {}),
      ...(typeof entry.y === 'number'
        ? { allowReplayRetry: entry.y === 1 }
        : {}),
      ...('x' in entry ? { tempIds: entry.x } : {}),
      ...('f' in entry ? { pendingConflict: entry.f } : {}),
    };
  }

  return toRecord(entry.data, 'Expected persisted queue data to be an object');
}

/**
 * Returns the persisted offline queue entries sorted by queue order, with only
 * the specified fields from the entry data. Removes `queueOrder` from the
 * output since it's only used for sorting.
 */
export function getSortedQueueSummary(
  sessionKey: string,
  storeName: string,
  fields: string[] = ['input', 'operation'],
): Array<Record<string, unknown>> {
  return getOfflineQueueEntries(sessionKey, storeName)
    .map((entry) => {
      const data = getOfflineQueueEntryData(entry);
      const result: Record<string, unknown> = {};

      for (const field of [...fields, 'queueOrder']) {
        result[field] = data[field];
      }

      return result;
    })
    .sort((left, right) => Number(left.queueOrder) - Number(right.queueOrder))
    .map(({ queueOrder: _, ...rest }) => rest);
}

export function getSortedSessionQueueSummary(
  sessionKey: string,
  fields: string[] = ['storeName', 'storeType', 'input', 'operation'],
): Array<Record<string, unknown>> {
  return getSessionOfflineQueueEntries(sessionKey)
    .map((entry) => {
      const data = getOfflineQueueEntryData(entry);
      const result: Record<string, unknown> = {};

      for (const field of [...fields, 'queueOrder']) {
        result[field] = data[field];
      }

      return result;
    })
    .sort((left, right) => Number(left.queueOrder) - Number(right.queueOrder))
    .map(({ queueOrder: _, ...rest }) => rest);
}
