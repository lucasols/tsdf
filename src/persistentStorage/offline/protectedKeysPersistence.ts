import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import type { AsyncStorageNamespaceScope } from '../types';

export const PROTECTED_KEYS_STORAGE_ENTRY_KEY = 'document';

export function getProtectedKeysStorageScope(
  sessionKey: string,
): AsyncStorageNamespaceScope {
  return { sessionKey, storeName: '_o_.p', kind: 'document' };
}

export type PersistedProtectedKeys = { keys: string[] };

export function serializeProtectedKeys(data: PersistedProtectedKeys): {
  k: string[];
} {
  return { k: data.keys };
}

export function parseProtectedKeys(
  value: unknown,
): PersistedProtectedKeys | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('k' in value) ||
    !Array.isArray(value.k)
  ) {
    return null;
  }

  return {
    keys: filterAndMap(value.k, (key) =>
      typeof key === 'string' ? key : false,
    ),
  };
}
