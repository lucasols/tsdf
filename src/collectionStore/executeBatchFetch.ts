import { deepEqual } from '@ls-stack/utils/deepEqual';
import { klona } from 'klona/json';
import { Store } from 't-state';
import {
  normalizeFetchResultError,
  runOfflineAwareFetch,
  type OfflineAwareFetchController,
} from '../persistentStorage/offline/fetchRuntime';
import { BatchRequest, FetchContext } from '../requestScheduler';
import { reusePrevIfEqual } from '../utils/reusePrevIfEqual';
import {
  DEFAULT_BATCH_KEY,
  normalizeStoreError,
  type MaybeTSDFResult,
  StoreError,
  unwrapMaybeTSDFResult,
  ValidPayload,
  ValidStoreState,
} from '../utils/storeShared';
import type { TSFDCollectionState } from './collectionStore';

export async function executeBatchFetch<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
>(
  requests: BatchRequest<ItemPayload>[],
  fetchCtx: FetchContext,
  store: Store<TSFDCollectionState<ItemState, ItemPayload>>,
  fetchFn: (
    params: ItemPayload,
    signal: AbortSignal,
  ) => Promise<MaybeTSDFResult<ItemState>>,
  batchFetchFn:
    | ((
        payloads: ItemPayload[],
        signal: AbortSignal,
        batchKey: string,
      ) => Promise<
        MaybeTSDFResult<Map<ItemPayload, MaybeTSDFResult<ItemState> | Error>>
      >)
    | undefined,
  errorNormalizer: (exception: Error) => StoreError,
  batchKey?: string,
  offlineController?: OfflineAwareFetchController | null,
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();

  // Set loading state for all items
  store.produceState(
    (draft) => {
      for (const { requestId: itemId, payload } of requests) {
        const current = draft[itemId];

        if (!current) {
          draft[itemId] = {
            data: null,
            error: null,
            status: 'loading',
            payload: klona(payload),
            refetchOnMount: false,
            wasLoaded: false,
          };
        } else {
          current.status = current.data !== null ? 'refetching' : 'loading';
          current.payload = klona(payload);
          current.error = null;
          current.refetchOnMount = false;
        }
      }
    },
    { equalityCheck: deepEqual, action: 'batch-fetch-start' },
  );

  // Check for early abort
  if (fetchCtx.shouldAbort()) {
    for (const { requestId } of requests) {
      results.set(requestId, false);
    }
    return results;
  }

  // If we have a batchFetchFn and multiple items, use batch fetch
  if (batchFetchFn && requests.length > 1) {
    try {
      const payloads = requests.map((r) => r.payload);
      const fetchResult = await runOfflineAwareFetch(offlineController, () =>
        batchFetchFn(payloads, fetchCtx.signal, batchKey ?? DEFAULT_BATCH_KEY),
      );

      if (!fetchResult.ok) {
        const error = normalizeFetchResultError(fetchResult, errorNormalizer);

        store.produceState(
          (draft) => {
            for (const { requestId: itemId } of requests) {
              const item = draft[itemId];
              if (!item) continue;

              if (fetchResult.offline && item.wasLoaded) {
                item.error = null;
                item.status = 'success';
              } else {
                item.error = error;
                item.status = 'error';
              }
              results.set(itemId, false);
            }
          },
          {
            action: fetchResult.offline
              ? 'batch-fetch-offline'
              : 'batch-fetch-error',
          },
        );

        return results;
      }

      const batchResults = fetchResult.data;

      if (fetchCtx.shouldAbort()) {
        for (const { requestId } of requests) {
          results.set(requestId, false);
        }
        return results;
      }

      // Process batch results
      store.produceState(
        (draft) => {
          for (const { requestId: itemId, payload } of requests) {
            const item = draft[itemId];
            if (!item) continue;

            const result = batchResults.get(payload);

            if (result instanceof Error) {
              item.error = normalizeStoreError(result, errorNormalizer);
              item.status = 'error';
              results.set(itemId, false);
            } else if (result !== undefined) {
              try {
                item.data = reusePrevIfEqual(
                  item.data,
                  unwrapMaybeTSDFResult(result),
                );
                item.status = 'success';
                item.wasLoaded = true;
                results.set(itemId, true);
              } catch (error) {
                item.error = normalizeStoreError(error, errorNormalizer);
                item.status = 'error';
                results.set(itemId, false);
              }
            } else {
              // No result for this item - mark as error
              item.error = errorNormalizer(
                new Error(`No result for item ${itemId}`),
              );
              item.status = 'error';
              results.set(itemId, false);
            }
          }
        },
        { action: 'batch-fetch-complete' },
      );

      return results;
    } catch (exception) {
      if (fetchCtx.shouldAbort()) {
        for (const { requestId } of requests) {
          results.set(requestId, false);
        }
        return results;
      }

      // All items fail with the same error
      const error = normalizeStoreError(exception, errorNormalizer);

      store.produceState(
        (draft) => {
          for (const { requestId: itemId } of requests) {
            const item = draft[itemId];
            if (!item) continue;

            item.error = error;
            item.status = 'error';
            results.set(itemId, false);
          }
        },
        { action: 'batch-fetch-error' },
      );

      return results;
    }
  }

  // Fall back to individual fetches (either single item or no batchFetchFn)
  const fetchPromises = requests.map(async ({ requestId: itemId, payload }) => {
    try {
      const fetchResult = await runOfflineAwareFetch(offlineController, () =>
        fetchFn(klona(payload), fetchCtx.signal),
      );
      if (!fetchResult.ok) {
        if (fetchCtx.shouldAbort()) {
          results.set(itemId, false);
          return;
        }

        const error = normalizeFetchResultError(fetchResult, errorNormalizer);

        store.produceState(
          (draft) => {
            const item = draft[itemId];
            if (!item) return;

            if (fetchResult.offline && item.wasLoaded) {
              item.error = null;
              item.status = 'success';
            } else {
              item.error = error;
              item.status = 'error';
            }
          },
          {
            action: fetchResult.offline ? 'fetch-error-offline' : 'fetch-error',
          },
        );

        results.set(itemId, false);
        return;
      }
      const data = fetchResult.data;

      if (fetchCtx.shouldAbort()) {
        results.set(itemId, false);
        return;
      }

      store.produceState(
        (draft) => {
          const item = draft[itemId];
          if (!item) return;

          item.data = reusePrevIfEqual(item.data, data);
          item.status = 'success';
          item.wasLoaded = true;
        },
        { action: 'fetch-success' },
      );

      results.set(itemId, true);
    } catch (exception) {
      if (fetchCtx.shouldAbort()) {
        results.set(itemId, false);
        return;
      }

      const error = normalizeStoreError(exception, errorNormalizer);

      store.produceState(
        (draft) => {
          const item = draft[itemId];
          if (!item) return;

          item.error = error;
          item.status = 'error';
        },
        { action: 'fetch-error' },
      );

      results.set(itemId, false);
    }
  });

  await Promise.all(fetchPromises);

  return results;
}
