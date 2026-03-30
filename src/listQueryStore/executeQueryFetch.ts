import { createAsyncQueue } from '@ls-stack/utils/asyncQueue';
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
import { NormalizedFetchListFn } from './createFetchApi';
import {
  type FetchListFnReturn,
  type OffsetPaginationConfig,
  type PartialResourcesConfig,
  type QueryFetchPayload,
  type TSFDListQueryState,
} from './types';

function applyFetchedItems<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
>(
  draft: TSFDListQueryState<ItemState, QueryPayload, ItemPayload>,
  queryKey: string,
  items: FetchListFnReturn<ItemState, ItemPayload>['items'],
  hasMore: boolean,
  fields: string[] | undefined,
  getItemKey: (params: ItemPayload) => string,
  partialResources: PartialResourcesConfig<ItemState> | undefined,
  appendToExisting: boolean,
) {
  const query = draft.queries[queryKey];
  if (!query) return;

  query.status = 'success';
  query.wasLoaded = true;
  query.hasMore = hasMore;

  if (!appendToExisting) {
    query.items = [];
  }

  const existingItemKeys = new Set(query.items);

  for (const { data, itemPayload } of items) {
    const itemKey = getItemKey(itemPayload);

    if (partialResources) {
      const prev = draft.items[itemKey] ?? undefined;
      const merged = partialResources.mergeItems(prev, data);
      draft.items[itemKey] = reusePrevIfEqual({ current: merged, prev });

      if (fields && fields.length > 0) {
        const existingFields = draft.itemLoadedFields[itemKey] ?? [];
        const fieldSet = new Set([...existingFields, ...fields]);
        draft.itemLoadedFields[itemKey] = Array.from(fieldSet).sort();
      } else {
        draft.itemLoadedFields[itemKey] = Object.keys(merged).sort();
      }

      const invalidationFields = draft.itemFieldInvalidationFields[itemKey];
      if (invalidationFields) {
        if (!fields || fields.length === 0) {
          delete draft.itemFieldInvalidationFields[itemKey];
        } else {
          const remainingFields = invalidationFields.filter(
            (field) => !fields.includes(field),
          );

          if (remainingFields.length > 0) {
            draft.itemFieldInvalidationFields[itemKey] = remainingFields;
          } else {
            delete draft.itemFieldInvalidationFields[itemKey];
          }
        }
      }
    } else {
      draft.items[itemKey] = reusePrevIfEqual({
        current: data,
        prev: draft.items[itemKey] ?? undefined,
      });
    }

    // Deduplicate: skip items already in the list (handles both append
    // and chunked invalidation where parallel chunks may return overlapping items)
    if (!existingItemKeys.has(itemKey)) {
      query.items.push(itemKey);
      existingItemKeys.add(itemKey);
    }

    const itemQuery = draft.itemQueries[itemKey];

    if (
      !itemQuery ||
      (itemQuery.status !== 'loading' && itemQuery.status !== 'refetching')
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
}

export async function executeQueryFetch<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
>(
  requests: BatchRequest<QueryFetchPayload<QueryPayload>>[],
  fetchCtx: FetchContext,
  store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>,
  normalizedFetchListFn: NormalizedFetchListFn<
    ItemState,
    QueryPayload,
    ItemPayload
  >,
  errorNormalizer: (exception: Error) => StoreError,
  getItemKey: (params: ItemPayload) => string,
  updateItemSchedulerTiming: (itemKey: string, startTime: number) => void,
  partialResources?: PartialResourcesConfig<ItemState>,
  offsetPagination?: OffsetPaginationConfig,
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
      const { payload, offset, limit, fields } = fetchPayload;

      try {
        // Determine if we need chunked invalidation (offset mode, load type, limit > maxInvalidationLimit)
        const useChunkedInvalidation =
          offsetPagination &&
          fetchPayload.type === 'load' &&
          limit > offsetPagination.maxInvalidationLimit;

        let allItems: FetchListFnReturn<ItemState, ItemPayload>['items'];
        let hasMore: boolean;

        if (useChunkedInvalidation) {
          // Split into multiple parallel chunk requests
          const maxChunkLimit = offsetPagination.maxInvalidationLimit;
          const chunks: { offset: number; limit: number }[] = [];
          for (
            let chunkOffset = offset;
            chunkOffset < offset + limit;
            chunkOffset += maxChunkLimit
          ) {
            chunks.push({
              offset: chunkOffset,
              limit: Math.min(maxChunkLimit, offset + limit - chunkOffset),
            });
          }

          const queue = createAsyncQueue<
            FetchListFnReturn<ItemState, ItemPayload>
          >({
            concurrency: offsetPagination.maxParallel ?? 3,
            stopOnError: true,
            rejectPendingOnError: true,
          });

          const chunkResultPromises = chunks.map((chunk) =>
            queue.resultifyAdd(() =>
              normalizedFetchListFn(payload, chunk.offset, chunk.limit, {
                signal: fetchCtx.signal,
                fields,
              }),
            ),
          );

          const chunkResults = await Promise.all(chunkResultPromises);
          const successResults = chunkResults.map((r) => r.unwrap());

          allItems = successResults.flatMap((r) => r.items);
          const lastChunk = successResults[successResults.length - 1];
          hasMore = lastChunk ? lastChunk.hasMore : false;
        } else {
          const result = await normalizedFetchListFn(payload, offset, limit, {
            signal: fetchCtx.signal,
            fields,
          });

          allItems = result.items;
          hasMore = result.hasMore;
        }

        if (fetchCtx.shouldAbort()) {
          results.set(queryKey, false);
          return;
        }

        // In offset mode, append only when loadMore range starts after head.
        // Coalesced loadMore+load can produce type='loadMore' with offset=0,
        // which must replace the list to avoid stale head items.
        const appendToExisting =
          !!offsetPagination && fetchPayload.type === 'loadMore' && offset > 0;

        store.produceState(
          (draft) => {
            applyFetchedItems(
              draft,
              queryKey,
              allItems,
              hasMore,
              fields,
              getItemKey,
              partialResources,
              appendToExisting,
            );
          },
          { action: 'query-fetch-success' },
        );

        for (const { itemPayload } of allItems) {
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
