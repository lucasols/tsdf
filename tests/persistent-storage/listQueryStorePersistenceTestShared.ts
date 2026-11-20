import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { rc_number, rc_object, rc_string } from 'runcheck';
import type {
  OffsetPaginationConfig,
  PartialResourcesConfig,
} from '../../src/listQueryStore/types';
import type { PersistentStorageSchema } from '../../src/persistentStorage/types';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { createLocalStoragePersistentTestStore } from '../utils/persistentStorageTestStore';

const rowSchema = __LEGIT_CAST__<PersistentStorageSchema<Row>, unknown>(
  rc_object({
    id: rc_number,
    name: rc_string,
    age: rc_number.optional(),
    email: rc_string.optional(),
  }),
);

const listQueryParamsSchema = rc_object({ tableId: rc_string });

export const persistentStore = createLocalStoragePersistentTestStore();

export function rawItemPayload(tableId: string, id: number): string {
  return `${tableId}||${id}`;
}

export function storeItemKey(tableId: string, id: number): string {
  return getCompositeKey(rawItemPayload(tableId, id));
}

function storeQueryKey(params: ListQueryParams): string {
  return getCompositeKey(params);
}

export function itemStorageKey(
  storeName: string,
  sessionKey: string,
  tableId: string,
  id: number,
): string {
  return `tsdf.${sessionKey}.${storeName}.li.${storeItemKey(tableId, id)}`;
}

export function queryStorageKey(
  storeName: string,
  sessionKey: string,
  params: ListQueryParams,
): string {
  return `tsdf.${sessionKey}.${storeName}.lq.${storeQueryKey(params)}`;
}

export function setCachedItem(
  storeName: string,
  sessionKey: string,
  tableId: string,
  id: number,
  data: Row,
  version: number | undefined = undefined,
  timestamp = Date.now(),
): string {
  return persistentStore
    .scope(storeName, sessionKey)
    .listQuery.seedItem(tableId, id, data, { version, timestamp }).storageKey;
}

export function setCachedQuery(
  storeName: string,
  sessionKey: string,
  params: ListQueryParams,
  items: string[],
  hasMore = false,
  version: number | undefined = undefined,
  timestamp = Date.now(),
): string {
  return persistentStore
    .scope(storeName, sessionKey)
    .listQuery.seedQuery(params, items, { hasMore, version, timestamp });
}

export function listStoredKeys(prefix: string): string[] {
  const keys: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) {
      keys.push(key.slice(prefix.length));
    }
  }

  return keys;
}

export function createEnv(options: {
  storeName: string;
  sessionKey?: string;
  version?: number;
  maxItemBytes?: number;
  maxQueryBytes?: number;
  maxQuerySize?: number;
  pinnedItems?: string[];
  pinnedQueries?: ListQueryParams[];
  ignoreItems?: string[] | ((payload: string) => boolean);
  serverData?: Tables<Row>;
  onPersistentStorageError?: (error: unknown) => void;
  partialResources?: PartialResourcesConfig<Row>;
  offsetPagination?: OffsetPaginationConfig;
  defaultQuerySize?: number;
  usesRealTimeUpdates?: boolean;
  dynamicRealtimeThrottleMs?: (params: {
    lastFetchDuration: number;
    windowIsNotFocused: boolean;
  }) => number;
  bindFocusController?: {
    getWindowIsFocused: () => boolean;
    onWindowFocus: (handler: () => void) => () => void;
    onWindowBlur: (handler: () => void) => () => void;
  };
}) {
  return createListQueryStoreTestEnv(options.serverData ?? {}, {
    id: options.storeName,
    getSessionKey: () => options.sessionKey ?? 'session1',
    partialResources: options.partialResources,
    offsetPagination: options.offsetPagination,
    defaultQuerySize: options.defaultQuerySize,
    usesRealTimeUpdates: options.usesRealTimeUpdates,
    dynamicRealtimeThrottleMs: options.dynamicRealtimeThrottleMs,
    bindFocusController: options.bindFocusController,
    persistentStorage: {
      adapter: 'local-sync',
      schema: rowSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: listQueryParamsSchema,
      version: options.version,
      maxItemBytes: options.maxItemBytes,
      maxQueryBytes: options.maxQueryBytes,
      maxQuerySize: options.maxQuerySize,
      pinnedItems: options.pinnedItems,
      pinnedQueries: options.pinnedQueries,
      ignoreItems: options.ignoreItems,
      onPersistentStorageError: options.onPersistentStorageError,
    },
  });
}
