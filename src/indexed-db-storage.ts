/* fast-lint-disable no-reexport -- public IndexedDB storage subpath entry */
export type { IndexedDbPersistentStorageOptions } from './persistentStorage/indexedDbAsyncStorageAdapter';
export {
  createIndexedDbPersistentStorage,
  indexedDbPersistentStorage,
} from './persistentStorage/indexedDbPersistentStorage';
