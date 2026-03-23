/* eslint-disable @ls-stack/no-reexport -- this is needed for the lib */
// Store creation functions
export { createCollectionStore } from './collectionStore/collectionStore';
export { createDocumentStore } from './documentStore';
export { createListQueryStore } from './listQueryStore/listQueryStore';

export { fetchTypePriority, StoreFetchError } from './utils/storeShared';
export { IsOffScreenContext } from './isOffScreenContext';

// Document Store types
export * from './documentStore';

// Collection Store types
export * from './collectionStore/collectionStore';

// List Query Store types
export type {
  ListQueryStore,
  ListQueryStoreEvents,
  ListQueryStoreOptions,
} from './listQueryStore/listQueryStore';

export type {
  FetchListFnReturn,
  FetchListFnReturnItem,
  FieldsInput,
  FieldsOption,
  ListQueryStoreInitialData,
  ListQueryUseMultipleItemsQuery,
  ListQueryUseMultipleListQueriesQuery,
  OffsetPaginationConfig,
  OnListQueryInvalidate,
  OnListQueryItemInvalidate,
  OptimisticListUpdate,
  PartialResourcesConfig,
  QueryFetchPayload,
  QueryStatus,
  TSDFItemQuery,
  TSFDListQuery,
  TSFDListQueryState,
  TSFDUseListItemReturn,
  TSFDUseListQueryReturn,
} from './listQueryStore/types';

// Shared types
export type {
  PayloadDebounce,
  StoreError,
  TSDFStatus,
  ValidPayload,
  ValidStoreState,
} from './utils/storeShared';

// Mutation types
export type {
  BlockWindowCloseHandler,
  MutationDebounce,
} from './utils/performMutation';

// Persistent Storage types
export type {
  AsyncStorageAdapter,
  PersistentStorageSchema,
  PersistentStorageDataSchema,
  ConvertedPersistentStorageDataSchema,
  PersistentStorageBaseConfig,
  PersistentStoragePreloadResult,
  DocumentPersistentStorageConfig,
  CollectionPersistentStorageConfig,
  ListQueryPersistentStorageConfig,
  StorageAdapter,
} from './persistentStorage/types';

export type {
  OfflineAccumulationConfig,
  OfflineAccumulationMergeContext,
  CollectionOfflineOperationDefinition,
  CollectionOfflineEntityRef,
  DefineCollectionOfflineOperations,
  DefineOfflineOperation,
  DefineDocumentOfflineOperations,
  DefineListQueryOfflineOperations,
  DocumentOfflineOperationDefinition,
  GlobalOfflineEntity,
  GlobalOfflineStatus,
  ListQueryOfflineEntityRef,
  ListQueryOfflineOperationDefinition,
  OfflineConflictRecord,
  OfflineMutationDescriptor,
  OfflineQueueEntry,
  OfflineSyncState,
} from './persistentStorage/offline/types';

export type { OfflineMutationResult } from './persistentStorage/offline/mutationRuntime';

export {
  getGlobalOfflineEntities,
  getGlobalOfflineStatus,
  useGlobalOfflineEntities,
  useGlobalOfflineStatus,
} from './persistentStorage/offline/sessionCoordinator';

// Persistent Storage utilities
export {
  clearSessionStorage,
  clearAllSessionStorage,
} from './persistentStorage/persistentStorageManager';

export {
  localPersistentStorage,
  opfsPersistentStorage,
} from './persistentStorage/storageAdapter';
