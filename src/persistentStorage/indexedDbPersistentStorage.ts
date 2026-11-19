import {
  createIndexedDbPersistentStorage as createIndexedDbPersistentStorageInternal,
  type IndexedDbPersistentStorageOptions,
} from './indexedDbAsyncStorageAdapter';
import type { AsyncStorageAdapter } from './types';

export const indexedDbPersistentStorage: AsyncStorageAdapter =
  /* @__PURE__ */
  createIndexedDbPersistentStorageInternal();

export function createIndexedDbPersistentStorage(
  options: IndexedDbPersistentStorageOptions = {},
): AsyncStorageAdapter {
  return createIndexedDbPersistentStorageInternal(options);
}
