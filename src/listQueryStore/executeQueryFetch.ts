import { createAsyncQueue } from '@ls-stack/utils/asyncQueue';
import { deepEqual } from '@ls-stack/utils/deepEqual';
import { klona } from 'klona/json';
import { Store } from 't-state';
import {
  offlineConnectivityError,
  runOfflineAwareFetch,
  type OfflineAwareFetchController,
} from '../persistentStorage/offline/fetchRuntime';
import { BatchRequest, FetchContext } from '../requestScheduler';
import { reusePrevIfEqual } from '../utils/reusePrevIfEqual';
import {
  normalizeStoreError,
  StoreError,
  ValidPayload,
  ValidStoreState,
} from '../utils/storeShared';
import { NormalizedFetchListFn } from './createFetchApi';
import { applyPartialItemMerge } from './itemFieldUtils';
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
  resolutionItemKeys: ReadonlySet<string>,
) {
  const query = draft.queries[queryKey];
  if (!query) return;

  // Items with a change waiting for a manual resolution keep their local
  // version, which the server data would replace: their data, staying hidden
  // when deleted locally, and, in the part of the list loaded before, whether
  // and where they are in it (the change may have moved them between lists,
  // or the server rejected their creation). Positions in the replaced list,
  // by item key.
  const keepsLocalMembership =
    resolutionItemKeys.size > 0 && query.wasLoaded && !appendToExisting;
  let keptPositions: Map<string, number> | null = null;
  // A fetch of a list with more rows to load (a load more replacing the list,
  // or a refetch with a larger size) returns the part loaded before first,
  // then the new rows, placed where the server lists them
  const newRowsStart = query.hasMore ? query.items.length : Infinity;

  query.status = 'success';
  query.wasLoaded = true;
  query.hasMore = hasMore;

  if (keepsLocalMembership) {
    for (const [index, itemKey] of query.items.entries()) {
      if (resolutionItemKeys.has(itemKey)) {
        keptPositions ??= new Map();
        keptPositions.set(itemKey, index);
      }
    }
  }

  if (!appendToExisting) {
    query.items = [];
  }

  const existingItemKeys = new Set(query.items);

  for (const [index, { data, itemPayload }] of items.entries()) {
    const itemKey = getItemKey(itemPayload);

    const keepsLocalVersion =
      resolutionItemKeys.size > 0 &&
      resolutionItemKeys.has(itemKey) &&
      draft.items[itemKey] !== undefined;

    if (keepsLocalVersion && draft.items[itemKey] === null) continue;

    if (partialResources) {
      applyPartialItemMerge(
        draft,
        itemKey,
        data,
        fields,
        partialResources,
        keepsLocalVersion,
      );

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
    } else if (!keepsLocalVersion) {
      draft.items[itemKey] = reusePrevIfEqual(
        draft.items[itemKey] ?? undefined,
        data,
      );
    }

    // Placed by `keptPositions` instead
    if (
      keepsLocalVersion &&
      keepsLocalMembership &&
      (index < newRowsStart || keptPositions?.has(itemKey))
    ) {
      continue;
    }

    // Deduplicate: skip items already in the list (handles both append
    // and chunked invalidation where parallel chunks may return overlapping items)
    if (!existingItemKeys.has(itemKey)) {
      query.items.push(itemKey);
      existingItemKeys.add(itemKey);
    }

    if (keepsLocalVersion) continue;

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

  if (keptPositions) {
    // Kept items go back where they were, unless the server data replaced
    // them (no local version to keep)
    for (const [itemKey, index] of keptPositions) {
      if (existingItemKeys.has(itemKey)) continue;

      query.items.splice(Math.min(index, query.items.length), 0, itemKey);
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
  partialResources: PartialResourcesConfig<ItemState> | undefined,
  offsetPagination: OffsetPaginationConfig | undefined,
  offlineController: OfflineAwareFetchController | null | undefined,
  resolutionItemKeys: ReadonlySet<string>,
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
      const { payload, limit, fields } = fetchPayload;

      // An offset loadMore continues after the loaded items, which may have
      // shrunk since it was scheduled, e.g. when it is the retry of a loadMore
      // aborted by a mutation that removed an item from the list. Items added
      // locally (e.g. optimistic creates) aren't part of the server pages
      // loaded so far, so they never move the offset forward.
      const isAppendLoadMore =
        !!offsetPagination &&
        fetchPayload.type === 'loadMore' &&
        fetchPayload.offset > 0;
      const offset = isAppendLoadMore
        ? Math.min(
            fetchPayload.offset,
            store.state.queries[queryKey]?.items.length ?? fetchPayload.offset,
          )
        : fetchPayload.offset;

      // In offset mode, append only when loadMore range starts after head.
      // Coalesced loadMore+load can produce type='loadMore' with offset=0,
      // which must replace the list to avoid stale head items.
      const appendToExisting =
        !!offsetPagination && fetchPayload.type === 'loadMore' && offset > 0;

      // The first failed request, kept here instead of being read back from
      // the caught exception: a chunk failure reaches the `catch` wrapped by
      // the chunk queue (which turns app errors that are not `Error`s into
      // generic ones), and an app error may use the `offline` id too.
      let failure:
        | { offline: true }
        | { offline: false; error: unknown }
        | null = null;

      try {
        // A fetch that replaces the list in offset mode (a load, or a loadMore
        // merged with one) is split into chunks of at most maxInvalidationLimit
        const useChunkedInvalidation =
          offsetPagination &&
          !appendToExisting &&
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
              runOfflineAwareFetch(offlineController, () =>
                normalizedFetchListFn(payload, chunk.offset, chunk.limit, {
                  signal: fetchCtx.signal,
                  fields,
                }),
              ).then((result) => {
                if (!result.ok) {
                  failure ??= result;
                  throw result.offline
                    ? offlineConnectivityError
                    : result.error;
                }
                return result.data;
              }),
            ),
          );

          const chunkResults = await Promise.all(chunkResultPromises);
          const successResults = chunkResults.map((r) => r.unwrap());

          allItems = successResults.flatMap((r) => r.items);
          const lastChunk = successResults[successResults.length - 1];
          hasMore = lastChunk ? lastChunk.hasMore : false;
        } else {
          const fetchResult = await runOfflineAwareFetch(
            offlineController,
            () =>
              normalizedFetchListFn(payload, offset, limit, {
                signal: fetchCtx.signal,
                fields,
              }),
          );
          if (!fetchResult.ok) {
            failure = fetchResult;
            throw fetchResult.offline
              ? offlineConnectivityError
              : fetchResult.error;
          }
          const result = fetchResult.data;

          allItems = result.items;
          hasMore = result.hasMore;
        }

        if (fetchCtx.shouldAbort()) {
          results.set(queryKey, false);
          return;
        }

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
              resolutionItemKeys,
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

        const failedOffline = failure?.offline === true;
        const error = failedOffline
          ? offlineConnectivityError
          : normalizeStoreError(
              failure && !failure.offline ? failure.error : exception,
              errorNormalizer,
            );
        store.produceState(
          (draft) => {
            const query = draft.queries[queryKey];
            if (!query) return;

            if (failedOffline && query.wasLoaded) {
              query.status = 'success';
              query.error = null;
            } else {
              query.status = 'error';
              query.error = error;
            }
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
