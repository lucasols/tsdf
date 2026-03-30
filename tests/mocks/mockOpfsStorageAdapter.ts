import type { StorageAdapter } from '../../src/persistentStorage/types';

import {
  createInMemoryPersistentTestStore,
  type PersistentTestStoreScope,
} from '../utils/persistentStorageTestStore';

type MockOpfsInitialScope = {
  storeName: string;
  sessionKey: string;
  document?: { data: unknown; timestamp?: number; version?: number };
  collection?: Array<{
    payload: string;
    data: unknown;
    timestamp?: number;
    version?: number;
  }>;
  listQuery?: {
    items?: Array<{
      tableId: string;
      id: number | string;
      data: unknown;
      loadedFields?: string[];
      timestamp?: number;
      version?: number;
    }>;
    queries?: Array<{
      params: unknown;
      items: Array<string | { tableId: string; id: number | string }>;
      hasMore?: boolean;
      timestamp?: number;
      version?: number;
    }>;
  };
};

function applyInitialScope(
  scope: PersistentTestStoreScope,
  initialScope: MockOpfsInitialScope,
) {
  if (initialScope.document) {
    scope.document.seed(initialScope.document.data, initialScope.document);
  }

  for (const item of initialScope.collection ?? []) {
    scope.collection.seedItem(item.payload, item.data, item);
  }

  for (const item of initialScope.listQuery?.items ?? []) {
    scope.listQuery.seedItem(item.tableId, item.id, item.data, item);
  }

  for (const query of initialScope.listQuery?.queries ?? []) {
    scope.listQuery.seedQuery(query.params, query.items, query);
  }
}

type MockOpfsStorageAdapterOptions = {
  readDelayMs?: number;
  storeName?: string;
  sessionKey?: string;
  initialState?: {
    document?: MockOpfsInitialScope['document'];
    collection?: MockOpfsInitialScope['collection'];
    listQuery?: MockOpfsInitialScope['listQuery'];
    rawEntries?: Record<string, unknown>;
  };
};

type MockOpfsStorageAdapterBase = {
  adapter: StorageAdapter;
  storage: ReturnType<typeof createInMemoryPersistentTestStore>['storage'];
  scope: ReturnType<typeof createInMemoryPersistentTestStore>['scope'];
  readRequests: string[];
  scopeReadRequests: () => string[];
  clearReadRequests: () => void;
  getRaw: (key: string) => string | null;
  has: (key: string) => boolean;
  setRaw: (key: string, raw: string) => void;
  setValue: <T>(key: string, value: T) => void;
};

export function createMockOpfsStorageAdapter(
  options: MockOpfsStorageAdapterOptions & {
    storeName: string;
    sessionKey: string;
  },
): MockOpfsStorageAdapterBase & PersistentTestStoreScope;
export function createMockOpfsStorageAdapter(
  options?: MockOpfsStorageAdapterOptions,
): MockOpfsStorageAdapterBase;

export function createMockOpfsStorageAdapter({
  readDelayMs = 0,
  storeName,
  sessionKey,
  initialState,
}: MockOpfsStorageAdapterOptions = {}): MockOpfsStorageAdapterBase &
  Partial<PersistentTestStoreScope> {
  const persistentStore = createInMemoryPersistentTestStore();
  const readRequests: string[] = [];
  const scopePrefix =
    storeName && sessionKey ? `tsdf.${sessionKey}.${storeName}.` : null;

  for (const [key, value] of Object.entries(initialState?.rawEntries ?? {})) {
    if (typeof value === 'string') {
      persistentStore.storage.writeRaw(key, value);
    } else {
      persistentStore.storage.writeValue(key, value);
    }
  }

  const scopedHelpers =
    storeName && sessionKey
      ? persistentStore.scope(storeName, sessionKey)
      : null;

  if (initialState) {
    if (!scopedHelpers || storeName === undefined || sessionKey === undefined) {
      throw new Error(
        'createMockOpfsStorageAdapter initialState requires storeName and sessionKey',
      );
    }

    applyInitialScope(scopedHelpers, {
      storeName,
      sessionKey,
      ...initialState,
    });
  }

  async function waitForReadDelay() {
    if (readDelayMs <= 0) return;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, readDelayMs);
    });
  }

  const adapter: StorageAdapter = {
    async read<T>(key: string): Promise<T | null> {
      try {
        readRequests.push(key);
        await waitForReadDelay();

        return persistentStore.storage.readEntry<T>(key);
      } catch {
        return null;
      }
    },

    write<T>(key: string, value: T): Promise<void> {
      persistentStore.storage.writeValue(key, value);
      return Promise.resolve();
    },

    remove(key: string): Promise<void> {
      persistentStore.storage.remove(key);
      return Promise.resolve();
    },

    removeByPrefix(prefix: string): Promise<void> {
      for (const key of persistentStore.storage.listKeys(prefix)) {
        persistentStore.storage.remove(key);
      }

      return Promise.resolve();
    },

    listKeys(prefix: string): Promise<string[]> {
      return Promise.resolve(persistentStore.storage.listKeys(prefix));
    },
  };

  return {
    adapter,
    storage: persistentStore.storage,
    scope: persistentStore.scope,
    ...(scopedHelpers ?? {}),
    readRequests,
    scopeReadRequests() {
      if (!scopePrefix) {
        return [...readRequests];
      }

      return readRequests.map((key) =>
        key.startsWith(scopePrefix) ? key.slice(scopePrefix.length) : key,
      );
    },
    clearReadRequests() {
      readRequests.length = 0;
    },
    getRaw(key: string) {
      return persistentStore.storage.getRaw(key);
    },
    has(key: string) {
      return persistentStore.storage.has(key);
    },
    setRaw(key: string, raw: string) {
      persistentStore.storage.writeRaw(key, raw);
    },
    setValue<T>(key: string, value: T) {
      persistentStore.storage.writeValue(key, value);
    },
  };
}
