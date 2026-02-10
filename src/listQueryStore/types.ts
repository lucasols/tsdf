import { FetchType } from '../requestScheduler';
import {
  StoreError,
  TSDFStatus,
  ValidPayload,
  ValidStoreState,
} from '../utils/storeShared';

export type FieldsInput = string[] | '*';

export type QueryStatus = TSDFStatus | 'loadingMore';

export type TSFDListQuery<QueryPayload extends ValidPayload> = {
  error: StoreError | null;
  status: QueryStatus;
  payload: QueryPayload;
  hasMore: boolean;
  wasLoaded: boolean;
  refetchOnMount: false | FetchType;
  items: string[];
};

export type TSDFItemQuery<ItemPayload extends ValidPayload> = {
  error: StoreError | null;
  status: Exclude<QueryStatus, 'loadingMore'>;
  wasLoaded: boolean;
  refetchOnMount: false | FetchType;
  payload: ItemPayload;
};

export type TSFDListQueryState<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = {
  items: Record<string, ItemState | null>;
  queries: Record<string, TSFDListQuery<QueryPayload>>;
  itemQueries: Record<string, TSDFItemQuery<ItemPayload> | null>;
  itemLoadedFields: Record<string, string[]>;
  itemFieldInvalidationFields: Record<string, string[]>;
};

export type TSFDUseListQueryReturn<
  Selected,
  QueryPayload,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
> = {
  items: Selected[];
  status: QueryStatus | 'idle';
  payload: QueryPayload | undefined;
  fields: FieldsInput | undefined;
  error: StoreError | null;
  queryKey: string;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  queryMetadata: QueryMetadata;
};

export type TSFDUseListItemReturn<
  Selected,
  ItemPayload,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
> = {
  data: Selected;
  status: QueryStatus | 'idle' | 'deleted';
  payload: ItemPayload | null;
  error: StoreError | null;
  isLoading: boolean;
  itemStateKey: string;
  queryMetadata: QueryMetadata;
};

export type FetchListFnReturnItem<
  ItemPayload extends ValidPayload,
  ItemState extends ValidStoreState,
> = {
  itemPayload: ItemPayload;
  data: ItemState;
};

export type FetchListFnReturn<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = {
  items: FetchListFnReturnItem<ItemPayload, ItemState>[];
  hasMore: boolean;
};

export type ListQueryStoreInitialData<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = {
  items: { payload: ItemPayload; data: ItemState }[];
  queries: {
    payload: QueryPayload;
    items: string[];
    hasMore: boolean;
  }[];
};

export type ListQueryUseMultipleItemsQuery<
  ItemPayload extends ValidPayload,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
> = {
  payload: ItemPayload;
  fields?: FieldsInput;
  queryMetadata?: QueryMetadata;
  disableRefetchOnMount?: boolean;
  returnIdleStatus?: boolean;
  returnRefetchingStatus?: boolean;
  isOffScreen?: boolean;
};

export type ListQueryUseMultipleListQueriesQuery<
  QueryPayload extends ValidPayload,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
> = {
  payload: QueryPayload;
  fields?: FieldsInput;
  queryMetadata?: QueryMetadata;
  omitPayload?: boolean;
  disableRefetchOnMount?: boolean;
  returnIdleStatus?: boolean;
  returnRefetchingStatus?: boolean;
  isOffScreen?: boolean;
  loadSize?: number;
};

export type OnListQueryInvalidate<QueryPayload extends ValidPayload> = (
  query: QueryPayload,
  priority: FetchType,
) => void;

export type OnListQueryItemInvalidate<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = (props: {
  itemState: ItemState;
  payload: ItemPayload;
  priority: FetchType;
}) => void;

export type OptimisticListUpdate<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = {
  queries: QueryPayload | ((query: QueryPayload) => boolean) | QueryPayload[];
  filterItem?: (item: ItemState) => boolean | null;
  appendNewTo?: 'start' | 'end';
  invalidateQueries?: boolean;
  sort?: {
    sortBy: (
      item: ItemState,
      itemPayload: ItemPayload,
    ) => string | number | (string | number)[];
    order?: 'asc' | 'desc' | ('asc' | 'desc')[];
  };
};

export type QueryFetchPayload<QueryPayload extends ValidPayload> = {
  type: 'load' | 'loadMore';
  payload: QueryPayload;
  size: number;
  fields?: string[];
};

export type PartialResourcesConfig<ItemState extends ValidStoreState> = {
  mergeItems: (prev: ItemState | undefined, fetched: ItemState) => ItemState;
  selectFields: (fields: string[], item: ItemState) => ItemState;
};

export type FieldsOption<HasPartialResources extends boolean> =
  HasPartialResources extends true
    ? { fields: FieldsInput }
    : { fields?: FieldsInput };
