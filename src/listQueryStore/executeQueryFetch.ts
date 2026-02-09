import { deepEqual } from '@ls-stack/utils/deepEqual';
import { klona } from 'klona/json';
import { unknownToError } from 't-result';
import { Store } from 't-state';
import { BatchRequest, FetchContext } from '../requestScheduler';
import { reusePrevIfEqual } from '../utils/reusePrevIfEqual';
import {
  StoreError,
  ValidPayload,
  ValidStoreState,
} from '../utils/storeShared';
import type {
  FetchListFnReturn,
  QueryFetchPayload,
  TSFDListQueryState,
} from './types';

export async function executeQueryFetch<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
>(
  requests: BatchRequest<QueryFetchPayload<QueryPayload>>[],
  fetchCtx: FetchContext,
  store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>,
  fetchListFn: (
    payload: QueryPayload,
    size: number,
    signal: AbortSignal,
  ) => Promise<FetchListFnReturn<ItemState, ItemPayload>>,
  errorNormalizer: (exception: Error) => StoreError,
  getItemKey: (params: ItemPayload) => string,
  updateItemSchedulerTiming: (itemKey: string, startTime: number) => void,
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();

  store.produceState(
    (draft) => {
      for (const { requestId: queryKey, payload: fetchPayload } of requests) {
        const { type, payload } = fetchPayload;
        const query = draft.queries[queryKey];

        if (!query) {
          draft.queries[queryKey] = {
            error: null,
            status: 'loading',
            wasLoaded: false,
            payload: klona(payload),
            refetchOnMount: false,
            hasMore: false,
            items: [],
          };
        } else {
          query.status = query.wasLoaded
            ? type === 'loadMore'
              ? 'loadingMore'
              : 'refetching'
            : 'loading';
          query.error = null;
          query.refetchOnMount = false;
        }
      }
    },
    { equalityCheck: deepEqual, action: 'query-fetch-start' },
  );

  if (fetchCtx.shouldAbort()) {
    for (const { requestId } of requests) {
      results.set(requestId, false);
    }
    return results;
  }

  const fetchPromises = requests.map(
    async ({ requestId: queryKey, payload: fetchPayload }) => {
      const { payload, size } = fetchPayload;

      try {
        const { items, hasMore } = await fetchListFn(
          payload,
          size,
          fetchCtx.signal,
        );

        if (fetchCtx.shouldAbort()) {
          results.set(queryKey, false);
          return;
        }

        store.produceState(
          (draft) => {
            const query = draft.queries[queryKey];
            if (!query) return;

            query.status = 'success';
            query.wasLoaded = true;
            query.hasMore = hasMore;
            query.items = [];

            for (const { data, itemPayload } of items) {
              const itemKey = getItemKey(itemPayload);

              draft.items[itemKey] = reusePrevIfEqual({
                current: data,
                prev: draft.items[itemKey] ?? undefined,
              });
              query.items.push(itemKey);

              const itemQuery = draft.itemQueries[itemKey];

              if (
                !itemQuery ||
                (itemQuery.status !== 'loading' &&
                  itemQuery.status !== 'refetching')
              ) {
                draft.itemQueries[itemKey] = {
                  error: null,
                  refetchOnMount: false,
                  status: 'success',
                  wasLoaded: true,
                  payload: itemPayload,
                };
              }
            }
          },
          { action: 'query-fetch-success' },
        );

        for (const { itemPayload } of items) {
          updateItemSchedulerTiming(
            getItemKey(itemPayload),
            fetchCtx.getStartTime(),
          );
        }

        results.set(queryKey, true);
      } catch (exception) {
        if (fetchCtx.shouldAbort()) {
          results.set(queryKey, false);
          return;
        }

        const error = errorNormalizer(unknownToError(exception));

        store.produceState(
          (draft) => {
            const query = draft.queries[queryKey];
            if (!query) return;

            query.status = 'error';
            query.error = error;
          },
          { action: 'query-fetch-error' },
        );

        results.set(queryKey, false);
      }
    },
  );

  await Promise.all(fetchPromises);

  return results;
}
