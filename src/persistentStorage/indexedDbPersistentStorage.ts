import {
  createIndexedDbPersistentStorage as createIndexedDbPersistentStorageInternal,
  type IndexedDbPersistentStorageOptions as IndexedDbPersistentStorageOptionsInternal,
} from './indexedDbAsyncStorageAdapter';
import type { AsyncStorageAdapter } from './types';

export const indexedDbPersistentStorage: AsyncStorageAdapter =
  /* @__PURE__ */
  createIndexedDbPersistentStorageInternal();

export type IndexedDbPersistentStorageOptions =
  IndexedDbPersistentStorageOptionsInternal;

export function createIndexedDbPersistentStorage(
  options: IndexedDbPersistentStorageOptions = {},
): AsyncStorageAdapter {
  return createIndexedDbPersistentStorageInternal(options);
}
