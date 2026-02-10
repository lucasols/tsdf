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
import type { TSFDListQueryState } from './types';

export async function executeItemBatchFetch<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
>(
  requests: BatchRequest<ItemPayload>[],
  fetchCtx: FetchContext,
  store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>,
  itemKeyToPayload: Map<string, ItemPayload>,
  fetchItemFn: (params: ItemPayload, signal: AbortSignal) => Promise<ItemState>,
  batchFetchItemFn:
    | ((
        payloads: ItemPayload[],
        signal: AbortSignal,
        batchKey: string,
      ) => Promise<Map<ItemPayload, ItemState | Error>>)
    | undefined,
  errorNormalizer: (exception: Error) => StoreError,
  batchKey?: string,
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();

  for (const { requestId, payload } of requests) {
    itemKeyToPayload.set(requestId, payload);
  }

  store.produceState(
    (draft) => {
      for (const { requestId: itemKey, payload } of requests) {
        const itemQuery = draft.itemQueries[itemKey];

        if (!itemQuery) {
          draft.itemQueries[itemKey] = {
            status: 'loading',
            error: null,
            wasLoaded: false,
            refetchOnMount: false,
            payload: klona(payload),
          };
        } else {
          itemQuery.status = itemQuery.wasLoaded ? 'refetching' : 'loading';
          itemQuery.error = null;
          itemQuery.refetchOnMount = false;
        }
      }
    },
    { equalityCheck: deepEqual, action: 'item-batch-fetch-start' },
  );

  if (fetchCtx.shouldAbort()) {
    for (const { requestId } of requests) {
      results.set(requestId, false);
    }
    return results;
  }

  if (batchFetchItemFn && requests.length > 1) {
    try {
      const payloads = requests.map((r) => r.payload);
      const batchResults = await batchFetchItemFn(
        payloads,
        fetchCtx.signal,
        batchKey ?? '__default__',
      );

      if (fetchCtx.shouldAbort()) {
        for (const { requestId } of requests) {
          results.set(requestId, false);
        }
        return results;
      }

      store.produceState(
        (draft) => {
          for (const { requestId: itemKey, payload } of requests) {
            const itemQuery = draft.itemQueries[itemKey];
            if (!itemQuery) continue;

            const result = batchResults.get(payload);

            if (result instanceof Error) {
              itemQuery.error = errorNormalizer(result);
              itemQuery.status = 'error';
              results.set(itemKey, false);
            } else if (result !== undefined) {
              draft.items[itemKey] = reusePrevIfEqual({
                current: result,
                prev: draft.items[itemKey] ?? undefined,
              });
              itemQuery.status = 'success';
              itemQuery.wasLoaded = true;
              results.set(itemKey, true);
            } else {
              itemQuery.error = errorNormalizer(
                new Error(`No result for item ${itemKey}`),
              );
              itemQuery.status = 'error';
              results.set(itemKey, false);
            }
          }
        },
        { action: 'item-batch-fetch-complete' },
      );

      return results;
    } catch (exception) {
      if (fetchCtx.shouldAbort()) {
        for (const { requestId } of requests) {
          results.set(requestId, false);
        }
        return results;
      }

      const error = errorNormalizer(unknownToError(exception));

      store.produceState(
        (draft) => {
          for (const { requestId: itemKey } of requests) {
            const itemQuery = draft.itemQueries[itemKey];
            if (!itemQuery) continue;

            itemQuery.error = error;
            itemQuery.status = 'error';
            results.set(itemKey, false);
          }
        },
        { action: 'item-batch-fetch-error' },
      );

      return results;
    }
  }

  const fetchPromises = requests.map(
    async ({ requestId: itemKey, payload }) => {
      try {
        const data = await fetchItemFn(klona(payload), fetchCtx.signal);

        if (fetchCtx.shouldAbort()) {
          results.set(itemKey, false);
          return;
        }

        store.produceState(
          (draft) => {
            const itemQuery = draft.itemQueries[itemKey];
            if (!itemQuery) return;

            draft.items[itemKey] = reusePrevIfEqual({
              current: data,
              prev: draft.items[itemKey] ?? undefined,
            });
            itemQuery.status = 'success';
            itemQuery.wasLoaded = true;
          },
          { action: 'item-fetch-success' },
        );

        results.set(itemKey, true);
      } catch (exception) {
        if (fetchCtx.shouldAbort()) {
          results.set(itemKey, false);
          return;
        }

        const error = errorNormalizer(unknownToError(exception));

        store.produceState(
          (draft) => {
            const itemQuery = draft.itemQueries[itemKey];
            if (!itemQuery) return;

            itemQuery.error = error;
            itemQuery.status = 'error';
          },
          { action: 'item-fetch-error' },
        );

        results.set(itemKey, false);
      }
    },
  );

  await Promise.all(fetchPromises);

  return results;
}
