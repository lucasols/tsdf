/* eslint-disable @ls-stack/no-reexport -- this is needed for the lib */
// Store creation functions
export { createCollectionStore } from './collectionStore/collectionStore';
export { createDocumentStore } from './documentStore';
export { createListQueryStore } from './listQueryStore/listQueryStore';

export { fetchTypePriority, StoreFetchError } from './utils/storeShared';

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

// Request Scheduler types
export type {
  BatchRequest,
  FetchContext,
  FetchType,
  PendingRequest,
  RequestSchedulerEvents,
  RequestSchedulerOptions,
  ScheduleFetchOptions,
  ScheduleFetchResults,
} from './requestScheduler';

// Shared types
export type {
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
