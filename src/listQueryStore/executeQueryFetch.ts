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
import {
  type FetchListFnReturn,
  type PartialResourcesConfig,
  type QueryFetchPayload,
  type TSFDListQueryState,
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
    options: { signal: AbortSignal; fields?: string[] },
  ) => Promise<FetchListFnReturn<ItemState, ItemPayload>>,
  errorNormalizer: (exception: Error) => StoreError,
  getItemKey: (params: ItemPayload) => string,
  updateItemSchedulerTiming: (itemKey: string, startTime: number) => void,
  partialResources?: PartialResourcesConfig<ItemState>,
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
      const { payload, size, fields } = fetchPayload;

      try {
        const { items, hasMore } = await fetchListFn(payload, size, {
          signal: fetchCtx.signal,
          fields,
        });

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

              if (partialResources) {
                const prev = draft.items[itemKey] ?? undefined;
                const merged = partialResources.mergeItems(prev, data);
                draft.items[itemKey] = reusePrevIfEqual({
                  current: merged,
                  prev,
                });

                if (fields && fields.length > 0) {
                  const existingFields = draft.itemLoadedFields[itemKey] ?? [];
                  const fieldSet = new Set([...existingFields, ...fields]);
                  draft.itemLoadedFields[itemKey] = Array.from(fieldSet).sort();
                }
              } else {
                draft.items[itemKey] = reusePrevIfEqual({
                  current: data,
                  prev: draft.items[itemKey] ?? undefined,
                });
              }

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
