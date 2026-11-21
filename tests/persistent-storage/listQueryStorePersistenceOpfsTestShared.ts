import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { rc_number, rc_object, rc_string } from 'runcheck';
import type {
  OffsetPaginationConfig,
  PartialResourcesConfig,
} from '../../src/listQueryStore/types';
import type { OfflineNetworkModeConfig } from '../../src/persistentStorage/offline/types';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import type { PersistentStorageSchema } from '../../src/persistentStorage/types';
import { createStoreManager } from '../../src/storeManager';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { normalizeError } from '../mocks/testEnvUtils';
import {
  createOpfsPersistentStorageTestStore,
  type OpfsPersistentStorageTestStoreOptions,
} from '../utils/opfsPersistentStorageTestStore';

const rowSchema = __LEGIT_CAST__<PersistentStorageSchema<Row>, unknown>(
  rc_object({
    id: rc_number,
    name: rc_string,
    age: rc_number.optional(),
    email: rc_string.optional(),
  }),
);
const listQueryParamsSchema = rc_object({ tableId: rc_string });

export function createEnv(options: {
  storeName: string;
  sessionKey?: string;
  maxItemBytes?: number;
  maxQueryBytes?: number;
  maxQuerySize?: number;
  ignoreItems?: string[] | ((payload: string) => boolean);
  pinnedItems?: string[];
  pinnedQueries?: ListQueryParams[];
  serverData?: Tables<Row>;
  partialResources?: PartialResourcesConfig<Row>;
  offsetPagination?: OffsetPaginationConfig;
  defaultQuerySize?: number;
  /** Makes the store offline-capable, tracking this network state. */
  offlineNetwork?: OfflineNetworkModeConfig;
}) {
  const getSessionKey = () => options.sessionKey ?? 'session1';

  return createListQueryStoreTestEnv(options.serverData ?? {}, {
    id: options.storeName,
    getSessionKey,
    storeManager: options.offlineNetwork
      ? createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey,
          offlineSession: { network: options.offlineNetwork },
        })
      : undefined,
    partialResources: options.partialResources,
    offsetPagination: options.offsetPagination,
    defaultQuerySize: options.defaultQuerySize,
    persistentStorage: {
      adapter: opfsPersistentStorage,
      schema: rowSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: listQueryParamsSchema,
      maxItemBytes: options.maxItemBytes,
      maxQueryBytes: options.maxQueryBytes,
      maxQuerySize: options.maxQuerySize,
      ignoreItems: options.ignoreItems,
      pinnedItems: options.pinnedItems,
      pinnedQueries: options.pinnedQueries,
      offline: options.offlineNetwork ? { operations: {} } : undefined,
    },
  });
}

export function createListQueryOpfsTestStore(options: {
  storeName: string;
  sessionKey: string;
  initialState?: NonNullable<
    OpfsPersistentStorageTestStoreOptions['initialState']
  >['listQuery'];
}) {
  const mockAdapter = createOpfsPersistentStorageTestStore({
    ...(options.initialState !== undefined
      ? {
          initialState: {
            storeName: options.storeName,
            sessionKey: options.sessionKey,
            listQuery: options.initialState,
          },
        }
      : {}),
  });
  const listQueryScope = mockAdapter.scope(
    options.storeName,
    options.sessionKey,
  ).listQuery;

  return { mockAdapter, listQueryScope };
}
