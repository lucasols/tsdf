import {
  convertStoreDataForPersistence,
  normalizePersistentStorageDataSchema,
} from '../../src/persistentStorage/parsePersistedData';
import type {
  PersistentStorageDataSchema,
  StorageAdapter,
} from '../../src/persistentStorage/types';
import type { ValidStoreState } from '../../src/utils/storeShared';
import { createLocalStoragePersistentTestStore } from '../utils/persistentStorageTestStore';

function convertForStorage<TState extends ValidStoreState, TStorage>(
  value: TState,
  schema: PersistentStorageDataSchema<TState, TStorage>,
): TState | TStorage {
  const normalizedSchema = normalizePersistentStorageDataSchema(schema);
  const converted = convertStoreDataForPersistence(value, normalizedSchema);
  if (!converted.ok) {
    throw converted.error;
  }

  return converted.value;
}

function parseRawListQueryItemPayload(payload: string): {
  tableId: string;
  rowId: string;
} {
  const separatorIndex = payload.indexOf('||');
  if (separatorIndex === -1) {
    throw new Error(
      `Expected list-query item payload in "tableId||id" format, got "${payload}"`,
    );
  }

  return {
    tableId: payload.slice(0, separatorIndex),
    rowId: payload.slice(separatorIndex + 2),
  };
}

export function seedDocumentScenarioPersistentStorage<
  TState extends ValidStoreState,
  TStorage,
>(args: {
  storeName: string;
  sessionKey: string | false;
  persistentStorage: {
    adapter: StorageAdapter;
    version?: number;
    schema: PersistentStorageDataSchema<TState, TStorage>;
  } | null;
  initialData: TState | undefined;
  timestamp?: number;
}): void {
  const { persistentStorage, sessionKey, initialData } = args;

  if (
    persistentStorage === null ||
    persistentStorage.adapter !== 'local-sync' ||
    sessionKey === false ||
    initialData === undefined
  ) {
    return;
  }

  const persistentStore = createLocalStoragePersistentTestStore();
  const scope = persistentStore.scope(args.storeName, sessionKey);
  const storageKey = scope.document.storageKey();

  if (scope.storage.has(storageKey)) return;

  scope.document.seed(
    convertForStorage(initialData, persistentStorage.schema),
    {
      timestamp: args.timestamp ?? Date.now(),
      version: persistentStorage.version,
    },
  );
}

type CollectionInitialData<TState> = Array<{ payload: string; data: TState }>;

export function seedCollectionScenarioPersistentStorage<
  TState extends ValidStoreState,
  TStorage,
>(args: {
  storeName: string;
  sessionKey: string | false;
  persistentStorage: {
    adapter: StorageAdapter;
    version?: number;
    schema: PersistentStorageDataSchema<TState, TStorage>;
  } | null;
  initialData: CollectionInitialData<TState> | undefined;
  timestamp?: number;
}): void {
  const { persistentStorage, sessionKey, initialData } = args;

  if (
    persistentStorage === null ||
    persistentStorage.adapter !== 'local-sync' ||
    sessionKey === false ||
    initialData === undefined
  ) {
    return;
  }

  const scope = createLocalStoragePersistentTestStore().scope(
    args.storeName,
    sessionKey,
  );
  const seedOptions = {
    timestamp: args.timestamp ?? Date.now(),
    version: persistentStorage.version,
  };

  for (const item of initialData) {
    if (scope.storage.has(scope.collection.itemStorageKey(item.payload))) {
      continue;
    }

    scope.collection.seedItem(
      item.payload,
      convertForStorage(item.data, persistentStorage.schema),
      seedOptions,
    );
  }
}

type ListQueryInitialData<TState, TQueryPayload> = {
  queries: Array<{ payload: TQueryPayload; hasMore: boolean; items: string[] }>;
  items: Array<{ payload: string; data: TState }>;
};

export function seedListQueryScenarioPersistentStorage<
  TState extends ValidStoreState,
  TQueryPayload,
  TStorage,
>(args: {
  storeName: string;
  sessionKey: string | false;
  persistentStorage: {
    adapter: StorageAdapter;
    version?: number;
    schema: PersistentStorageDataSchema<TState, TStorage>;
  } | null;
  initialData: ListQueryInitialData<TState, TQueryPayload> | undefined;
  timestamp?: number;
}): void {
  const { persistentStorage, sessionKey, initialData } = args;

  if (
    persistentStorage === null ||
    persistentStorage.adapter !== 'local-sync' ||
    sessionKey === false ||
    initialData === undefined
  ) {
    return;
  }

  const scope = createLocalStoragePersistentTestStore().scope(
    args.storeName,
    sessionKey,
  );
  const seedOptions = {
    timestamp: args.timestamp ?? Date.now(),
    version: persistentStorage.version,
  };

  for (const item of initialData.items) {
    const { tableId, rowId } = parseRawListQueryItemPayload(item.payload);
    if (scope.storage.has(scope.listQuery.itemStorageKey(tableId, rowId))) {
      continue;
    }

    scope.listQuery.seedItem(
      tableId,
      rowId,
      convertForStorage(item.data, persistentStorage.schema),
      seedOptions,
    );
  }

  for (const query of initialData.queries) {
    if (scope.storage.has(scope.listQuery.queryStorageKey(query.payload))) {
      continue;
    }

    scope.listQuery.seedQuery(query.payload, query.items, {
      ...seedOptions,
      hasMore: query.hasMore,
    });
  }
}
