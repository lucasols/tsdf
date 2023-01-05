import mitt from 'mitt';
import { Store } from 't-state';
import { createCollectionFetchOrquestrator } from './collectionFetchOrquestrator';
import {
  FetchType,
  ScheduleFetchResults,
  ShouldAbortFetch,
} from './fetchOrquestrator';
import { Status, ValidFetchParams, ValidStoreState } from './storeShared';
import { filterAndMap } from './utils/filterAndMap';
import { getCacheId } from './utils/getCacheId';
import { serializableClone } from './utils/serializableClone';

type CollectionItemStatus = Status | 'deleted';

export type TSFDCollectionItem<
  ItemState extends ValidStoreState,
  ItemPayload,
  Error,
> = {
  data: ItemState | null;
  error: Error | null;
  status: CollectionItemStatus;
  payload: ItemPayload;
  refetchOnMount: boolean;
};

export type TSFDCollectionState<
  ItemState extends ValidStoreState,
  ItemPayload,
  Error,
> = Record<string, TSFDCollectionItem<ItemState, ItemPayload, Error>>;

export function newTSDFCollectionStore<
  ItemState extends ValidStoreState,
  Error,
  FetchParams extends ValidFetchParams,
  ItemPayload,
>({
  debugName,
  fetchFn,
  disableRefetchOnWindowFocus,
  lowPriorityThrottleMs,
  errorNormalizer,
  mediumPriorityThrottleMs,
  getDynamicRealtimeThrottleMs,
  getCollectionItemPayload,
}: {
  debugName?: string;
  fetchFn: (params: FetchParams) => Promise<ItemState>;
  getCollectionItemPayload: (params: FetchParams) => ItemPayload;
  errorNormalizer: (exception: unknown) => Error;
  disableRefetchOnWindowFocus?: boolean;
  disableRefetchOnMount?: boolean;
  lowPriorityThrottleMs?: number;
  mediumPriorityThrottleMs?: number;
  getDynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
}) {
  type CollectionState = TSFDCollectionState<ItemState, ItemPayload, Error>;
  type CollectionItem = TSFDCollectionItem<ItemState, ItemPayload, Error>;

  const store = new Store<CollectionState>({
    debugName,
    state: {},
  });

  function getItemId(params: FetchParams): string {
    return getCacheId(getCollectionItemPayload(params));
  }

  async function fetch(
    shouldAbort: ShouldAbortFetch,
    params: FetchParams,
  ): Promise<boolean> {
    const itemId = getItemId(params);
    const payload = serializableClone(getCollectionItemPayload(params));

    const itemState = store.state[itemId];

    store.produceState(
      (draft) => {
        if (!draft[itemId]) {
          draft[itemId] = {
            data: null,
            error: null,
            status: 'loading',
            payload,
            refetchOnMount: false,
          };

          return;
        }

        const item = draft[itemId]!;

        item.status = item.data !== null ? 'refetching' : 'loading';
        item.payload = payload;
        item.error = null;
        item.refetchOnMount = false;
      },
      {
        action: {
          type: !itemState?.data
            ? 'fetch-start-loading'
            : 'fetch-start-refetching',
          payload,
        },
      },
    );

    try {
      const data = await fetchFn(params);

      if (shouldAbort()) return false;

      store.produceState(
        (draft) => {
          const item = draft[itemId];

          if (!item) return;

          item.data = data;
          item.status = 'success';
        },
        { action: { type: 'fetch-success', payload } },
      );

      return true;
    } catch (exception) {
      if (shouldAbort()) return false;

      store.produceState(
        (draft) => {
          const item = draft[itemId];

          if (!item) return;

          item.error = errorNormalizer(exception);
          item.status = 'error';
        },
        { action: { type: 'fetch-error', payload } },
      );

      return false;
    }
  }

  const fetchOrquestrator = createCollectionFetchOrquestrator({
    fetchFn: fetch,
    lowPriorityThrottleMs,
    getDynamicRealtimeThrottleMs,
    mediumPriorityThrottleMs,
  });

  function scheduleFetch(
    fetchType: FetchType,
    params: FetchParams,
  ): ScheduleFetchResults {
    return fetchOrquestrator
      .get(getItemId(params))
      .scheduleFetch(fetchType, params);
  }

  async function awaitFetch(
    params: FetchParams,
  ): Promise<{ data: null; error: Error } | { data: ItemState; error: null }> {
    const itemId = getItemId(params);

    const fetchOrquestratorItem = fetchOrquestrator.get(itemId);

    const wasAborted = await fetchOrquestratorItem.awaitFetch(params);

    if (wasAborted) {
      return { data: null, error: errorNormalizer(new Error('Aborted')) };
    }

    const item = store.state[itemId];

    if (!item?.data) {
      return { data: null, error: errorNormalizer(new Error('Not found')) };
    }

    return item.error
      ? { data: null, error: item.error }
      : { data: item.data, error: null };
  }

  type FilterItemsFn = (params: ItemPayload) => boolean;
  function getItemsIdArray(
    params: FetchParams[] | FilterItemsFn | FetchParams,
  ): string[] {
    const items = store.state;

    if (Array.isArray(params)) {
      return params.map(getItemId);
    } else if (typeof params === 'function') {
      const ids: string[] = [];

      for (const [itemId, item] of Object.entries(items)) {
        if (params(item.payload)) {
          ids.push(itemId);
        }
      }

      return filterAndMap(Object.entries(items), ([itemId, item], ignore) => {
        if (params(item.payload)) {
          return itemId;
        }

        return ignore;
      });
    } else {
      return [getItemId(params)];
    }
  }

  const storeEvents = mitt<{
    invalidateData: { priority: FetchType; itemId: string };
  }>();

  const invalidationWasTriggered = new Set<string>();

  function invalidateData(
    params: FetchParams | FetchParams[] | FilterItemsFn,
    priority: 'highPriority' | 'lowPriority' = 'highPriority',
  ) {
    const itemsId = getItemsIdArray(params);

    for (const itemId of itemsId) {
      store.produceState((draft) => {
        const item = draft[itemId];

        if (!item) return;

        item.refetchOnMount = true;
      });

      invalidationWasTriggered.delete(itemId);
      storeEvents.emit('invalidateData', { priority, itemId });
    }
  }

  function getItemState(params: FetchParams): CollectionItem | undefined;
  function getItemState(
    itemId: FetchParams[] | FilterItemsFn,
  ): CollectionItem[] | undefined;
  function getItemState(
    params: FetchParams | FetchParams[] | FilterItemsFn,
  ): CollectionItem | CollectionItem[] | undefined {
    if (typeof params === 'function' || Array.isArray(params)) {
      const itemsId = getItemsIdArray(params);

      return filterAndMap(itemsId, (itemId, ignore) => {
        return store.state[itemId] || ignore;
      });
    }

    return store.state[getItemId(params)];
  }

  return {
    store,
    scheduleFetch,
    awaitFetch,
    getItemId,
    getItemState,
    invalidateData,
  };
}

// FIX: create a type for this
export type TSDFCollectionStore<
  ItemState extends ValidStoreState,
  Error,
  FetchParams extends ValidFetchParams,
  ItemPayload,
> = ReturnType<
  typeof newTSDFCollectionStore<ItemState, Error, FetchParams, ItemPayload>
>;
