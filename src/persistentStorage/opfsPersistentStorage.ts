import { createAsyncStorageAdapter } from './asyncStorageAdapter';
import { OpfsAsyncStorageDriver } from './opfsAsyncStorageAdapter';
import type { AsyncStorageAdapter } from './types';

export const opfsPersistentStorage: AsyncStorageAdapter =
  /* @__PURE__ */
  // The driver needs its own annotation: bundlers keep side-effectful
  // arguments of pure calls, which would retain the whole OPFS driver.
  createAsyncStorageAdapter(/* @__PURE__ */ new OpfsAsyncStorageDriver());
