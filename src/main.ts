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
  DerivedQueriesConfig,
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
  AsyncStorageDiscoveredScope,
  AsyncStorageDriver,
  AsyncStorageDriverSetEntry,
  AsyncStorageMetadataOrder,
  AsyncStorageNamespaceCommitArgs,
  AsyncStorageNamespaceCommitTouch,
  AsyncStorageNamespaceCommitUpsert,
  AsyncStorageNamespaceGetResult,
  AsyncStorageNamespaceHandle,
  AsyncStorageNamespaceKind,
  AsyncStorageNamespaceScope,
  AsyncStorageReadOptions,
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
  OfflineConflictResolutionAction,
  GlobalOfflineEntity,
  GlobalOfflineStatus,
  OfflineMutationInput,
  OfflineRuntimeConfig,
  OfflineRuntimeConfigUpdate,
  OfflineMutationQueueingConfig,
  OfflineMutationQueueingCause,
  OfflineMutationQueueingPolicy,
  OfflineSession,
  OfflineSessionConfig,
  OfflineReplayRetryConfig,
  OfflineResolutionAction,
  OfflineResolutionActionForOperation,
  OfflineResolutionConflictParseErrorCode,
  OfflineResolutionConflictParseError,
  OfflineResolutionRecordForStore,
  OfflineResolutionRecordForOperation,
  OfflineSupersedeConfig,
  ListQueryOfflineEntityRef,
  ListQueryOfflineOperationDefinition,
  OfflineResolutionRecord,
  OfflineRetryExhaustedResolutionAction,
  OfflineMutationDescriptor,
  OfflineQueueEntry,
  OperationConflict,
  OperationResult,
  ParsedOfflineResolutionConflictResultForOperation,
  OfflineSyncState,
  OfflineTempEntitiesConfig,
  OfflineTempEntitiesReconciliation,
  OfflineTempEntityConfig,
  OfflineTempEntityPendingEntry,
} from './persistentStorage/offline/types';

export { defaultOfflineRuntimeConfig } from './persistentStorage/offline/types';

export type { OfflineMutationResult } from './persistentStorage/offline/mutationRuntime';

export {
  createOfflineSession,
  getGlobalOfflineEntities,
  getGlobalOfflineResolutions,
  getGlobalOfflineStatus,
  useGlobalOfflineEntities,
  useGlobalOfflineResolutions,
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

export { createAsyncStorageAdapter } from './persistentStorage/asyncStorageAdapter';
