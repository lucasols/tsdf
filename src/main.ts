/* eslint-disable @ls-stack/no-reexport -- this is needed for the lib */
// Store creation functions
export { createCollectionStore } from './collectionStore/collectionStore';
export { createDocumentStore } from './documentStore';
export { createListQueryStore } from './listQueryStore/listQueryStore';

export {
  fetchTypePriority,
  mutationSkipped,
  StoreFetchError,
  StoreMutationError,
} from './utils/storeShared';
export { GET_ALL } from './invalidationUtils';
export { IsOffScreenContext } from './isOffScreenContext';
export {
  createStoreManager,
  type CreateStoreManagerOptions,
  type DynamicRealtimeThrottleMs,
  type StoreManager,
} from './storeManager';
export type {
  TSDFDebugLogArea,
  TSDFDebugLogger,
  TSDFDebugLogEntry,
  TSDFDebugLogLevel,
  TSDFDebugOptions,
} from './debug';

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
  DerivedQueryContext,
  DerivedQueriesConfig,
  FetchListFnReturn,
  FetchListFnReturnItem,
  FieldsInput,
  FieldsOption,
  DerivedQuerySource,
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
  TSFDUsePendingOfflineItemsReturn,
} from './listQueryStore/types';

// Shared types
export type {
  MaybeTSDFResult,
  MutationSkipped,
  PayloadDebounce,
  StoreError,
  StoreMutationErrorOptions,
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
  OfflineMutationUploadsInput,
  OfflineOperationUploadsContext,
  OfflineSessionUploadsConfig,
  OfflineStoredUploadRecord,
  OfflineUpload,
  OfflineUploadAdapter,
  OfflineUploadProgress,
  OfflineUploadSource,
  OfflineUploadState,
  OfflineUploadTransportContext,
} from './persistentStorage/offlineUploadTypes';

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
  OfflineEntityMutationKind,
  GlobalOfflineEntity,
  GlobalOfflineStatus,
  OfflineMutationInput,
  OfflineOperationKind,
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

export { localPersistentStorage } from './persistentStorage/storageAdapter';
export { opfsOfflineUploadAdapter } from './persistentStorage/opfsOfflineUploadAdapter';
