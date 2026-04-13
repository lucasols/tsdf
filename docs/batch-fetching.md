# Batch Fetching

Batch fetching allows multiple item fetches to be combined into a single network request. Available in [Collection Store](./collection-store.md) and [List Query Store](./list-query-store.md).

## How It Works

When multiple items need to be fetched around the same time, the [fetch scheduler](./fetch-scheduling.md) groups them during the coalescing window and sends them as a single batch request via your `batchFetchFn`.

Without batch fetching, each item triggers its own `fetchFn` call. With batch fetching, items are grouped and passed to `batchFetchFn` together.

## Collection Store

```ts
const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  errorNormalizer: normalizeError,
});

const store = createCollectionStore<Product, string>({
  storeManager,
  // Individual fetch (fallback when batch is not used)
  fetchFn: (productId, signal) => api.getProduct(productId, signal),

  // Batch fetch — receives an array of payloads
  batchFetchFn: (productIds, signal, batchKey) => {
    return api.getProducts(productIds, signal);
    // Returns Map<string, Product | Error>
  },

  // ...other options
});
```

The `batchFetchFn` must return a `Map` where:

- Keys are the original payloads
- Values are either the fetched data or an `Error` for failed items

Items that return an `Error` in the map are handled individually with the error normalizer.

## List Query Store

```ts
const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  errorNormalizer: normalizeError,
});

const store = createListQueryStore<Task, TaskFilter, string>({
  storeManager,
  fetchListFn: (filter, size, { signal }) => api.getTasks(filter, size, signal),

  // Individual item fetch
  fetchItemFn: (taskId, { signal, fields }) => api.getTask(taskId, signal),

  // Batch item fetch
  batchFetchItemFn: (requests, { signal, batchKey }) => {
    const payloads = requests.map((r) => r.payload);
    return api.getTasks(payloads, signal);
    // Returns Map<string, Task | Error>
  },

  // ...other options
});
```

In List Query Store, `batchFetchItemFn` receives an array of `{ payload, fields? }` objects, allowing each item to request different fields when using [Partial Resources](./partial-resources.md).

## Batch Keys

By default, all items share a single batch scheduler (batch key `'__default__'`). Use `getItemsBatchKey` to group items into separate batches:

```ts
const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  errorNormalizer: normalizeError,
});

const store = createCollectionStore<Resource, { type: string; id: string }>({
  storeManager,
  fetchFn: (params, signal) => api.getResource(params, signal),
  batchFetchFn: (payloads, signal, batchKey) => {
    // batchKey is the type — batch requests by resource type
    return api.getResourcesByType(batchKey, payloads, signal);
  },

  // Group batches by resource type
  getItemsBatchKey: (payload) => payload.type,

  // ...other options
});
```

### Opting Out Per Item

Return `false` from `getItemsBatchKey` to fall back to per-item `fetchFn` for specific items:

```ts
getItemsBatchKey: (payload) => {
  if (payload.type === 'special') return false; // use individual fetchFn
  return payload.type; // batch all others by type
},
```

## Max Batch Size

When `maxBatchSize` is set, the scheduler triggers an immediate fetch (skipping the remaining coalescing window) once the batch reaches that size:

```ts
{
  batchFetchFn: /* ... */,
  maxBatchSize: 50, // fire immediately when 50 items are queued
}
```

This is useful when you know your API has a limit on batch size.

## Scheduler Lifecycle

When using batch fetching:

- A single scheduler is created per batch key
- All items with the same batch key share the scheduler's throttling and coalescing
- When all items for a batch key are deleted from the store, the scheduler is cleaned up
- Per-item schedulers are used for items that opt out of batching (`getItemsBatchKey` returns `false`)
