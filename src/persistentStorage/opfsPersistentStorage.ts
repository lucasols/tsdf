import { createAsyncStorageAdapter } from './asyncStorageAdapter';
import { OpfsAsyncStorageDriver } from './opfsAsyncStorageAdapter';
import type { AsyncStorageAdapter } from './types';

export const opfsPersistentStorage: AsyncStorageAdapter =
  /* @__PURE__ */
  createAsyncStorageAdapter(new OpfsAsyncStorageDriver());
