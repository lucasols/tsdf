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
import { type PartialResourcesConfig, type TSFDListQueryState } from './types';

type ItemFetchData<ItemPayload extends ValidPayload> = {
  payload: ItemPayload;
  fields?: string[];
};

export async function executeItemBatchFetch<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
>(
  requests: BatchRequest<ItemFetchData<ItemPayload>>[],
  fetchCtx: FetchContext,
  store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>,
  itemKeyToPayload: Map<string, ItemPayload>,
  fetchItemFn: (
    params: ItemPayload,
    options: { signal: AbortSignal; fields?: string[] },
  ) => Promise<ItemState>,
  batchFetchItemFn:
    | ((
        requests: { payload: ItemPayload; fields?: string[] }[],
        options: { signal: AbortSignal },
      ) => Promise<Map<ItemPayload, ItemState | Error>>)
    | undefined,
  errorNormalizer: (exception: Error) => StoreError,
  partialResources?: PartialResourcesConfig<ItemState>,
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();

  function applyItemResult(
    draft: TSFDListQueryState<ItemState, QueryPayload, ItemPayload>,
    itemKey: string,
    data: ItemState,
    fields?: string[],
  ) {
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
    } else {
      draft.items[itemKey] = reusePrevIfEqual({
        current: data,
        prev: draft.items[itemKey] ?? undefined,
      });
    }
  }

  function requestSatisfiesFieldInvalidation(
    requestFields: string[] | undefined,
    invalidationFields: string[] | undefined,
  ): boolean {
    if (!requestFields || requestFields.length === 0) return false;
    if (!invalidationFields || invalidationFields.length === 0) return false;

    return invalidationFields.every((field) => requestFields.includes(field));
  }

  for (const { requestId, payload: data } of requests) {
    itemKeyToPayload.set(requestId, data.payload);
  }

  store.produceState(
    (draft) => {
      for (const { requestId: itemKey, payload: data } of requests) {
        const itemQuery = draft.itemQueries[itemKey];
        const invalidationFields = draft.itemFieldInvalidationFields[itemKey];
        if (
          invalidationFields &&
          !requestSatisfiesFieldInvalidation(data.fields, invalidationFields)
        ) {
          delete draft.itemFieldInvalidationFields[itemKey];
        }

        if (!itemQuery) {
          draft.itemQueries[itemKey] = {
            status: 'loading',
            error: null,
            wasLoaded: false,
            refetchOnMount: false,
            payload: klona(data.payload),
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
      const batchRequests = requests.map((r) => ({
        payload: r.payload.payload,
        fields: r.payload.fields,
      }));
      const batchResults = await batchFetchItemFn(batchRequests, {
        signal: fetchCtx.signal,
      });

      if (fetchCtx.shouldAbort()) {
        for (const { requestId } of requests) {
          results.set(requestId, false);
        }
        return results;
      }

      store.produceState(
        (draft) => {
          for (const { requestId: itemKey, payload: data } of requests) {
            const itemQuery = draft.itemQueries[itemKey];
            if (!itemQuery) continue;

            const result = batchResults.get(data.payload);

            if (result instanceof Error) {
              itemQuery.error = errorNormalizer(result);
              itemQuery.status = 'error';
              delete draft.itemFieldInvalidationFields[itemKey];
              results.set(itemKey, false);
            } else if (result !== undefined) {
              applyItemResult(draft, itemKey, result, data.fields);
              itemQuery.status = 'success';
              itemQuery.wasLoaded = true;
              delete draft.itemFieldInvalidationFields[itemKey];
              results.set(itemKey, true);
            } else {
              itemQuery.error = errorNormalizer(
                new Error(`No result for item ${itemKey}`),
              );
              itemQuery.status = 'error';
              delete draft.itemFieldInvalidationFields[itemKey];
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
            delete draft.itemFieldInvalidationFields[itemKey];
            results.set(itemKey, false);
          }
        },
        { action: 'item-batch-fetch-error' },
      );

      return results;
    }
  }

  const fetchPromises = requests.map(
    async ({ requestId: itemKey, payload: requestData }) => {
      try {
        const data = await fetchItemFn(klona(requestData.payload), {
          signal: fetchCtx.signal,
          fields: requestData.fields,
        });

        if (fetchCtx.shouldAbort()) {
          results.set(itemKey, false);
          return;
        }

        store.produceState(
          (draft) => {
            const itemQuery = draft.itemQueries[itemKey];
            if (!itemQuery) return;

            applyItemResult(draft, itemKey, data, requestData.fields);
            itemQuery.status = 'success';
            itemQuery.wasLoaded = true;
            delete draft.itemFieldInvalidationFields[itemKey];
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
            delete draft.itemFieldInvalidationFields[itemKey];
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
