import type { ItemLoadedFields } from '../../src/listQueryStore/types';
import {
  createLocalStoragePersistentTestStore,
  type PersistentTestStoreScope,
} from '../utils/persistentStorageTestStore';

type MockLocalStorageInitialScope = {
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
      loadedFields?: ItemLoadedFields;
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
  initialScope: MockLocalStorageInitialScope,
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

type MockLocalStorageStoreOptions = {
  storeName?: string;
  sessionKey?: string;
  initialState?: {
    document?: MockLocalStorageInitialScope['document'];
    collection?: MockLocalStorageInitialScope['collection'];
    listQuery?: MockLocalStorageInitialScope['listQuery'];
    rawEntries?: Record<string, unknown>;
  };
};

type MockLocalStorageStoreBase = {
  storage: ReturnType<typeof createLocalStoragePersistentTestStore>['storage'];
  scope: ReturnType<typeof createLocalStoragePersistentTestStore>['scope'];
  getRaw: (key: string) => string | null;
  has: (key: string) => boolean;
  setRaw: (key: string, raw: string) => void;
  setValue: <T>(key: string, value: T) => void;
};

export function createMockLocalStorageStore(
  options: MockLocalStorageStoreOptions & {
    storeName: string;
    sessionKey: string;
  },
): MockLocalStorageStoreBase & PersistentTestStoreScope;
export function createMockLocalStorageStore(
  options?: MockLocalStorageStoreOptions,
): MockLocalStorageStoreBase;

export function createMockLocalStorageStore({
  storeName,
  sessionKey,
  initialState,
}: MockLocalStorageStoreOptions = {}): MockLocalStorageStoreBase &
  Partial<PersistentTestStoreScope> {
  const persistentStore = createLocalStoragePersistentTestStore();

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
        'createMockLocalStorageStore initialState requires storeName and sessionKey',
      );
    }

    applyInitialScope(scopedHelpers, {
      storeName,
      sessionKey,
      ...initialState,
    });
  }

  return {
    storage: persistentStore.storage,
    scope: persistentStore.scope,
    ...(scopedHelpers ?? {}),
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
