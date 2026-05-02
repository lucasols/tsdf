# Cache Limits

Collection stores and list-query stores keep recently used state in memory. Cache limits bound that in-memory state so long-lived apps can browse many items or queries without keeping every result forever.

See also: [Collection Store](./collection-store.md) | [List Query Store](./list-query-store.md) | [Persistent Storage](./persistent-storage.md)

## What is limited

Cache limits only affect live in-memory store state.

- `CollectionStore` limits cached item entries with `maxItems`.
- `ListQueryStore` limits cached item entries with `maxItems` and cached query entries with `maxQueries`.
- Persistent storage has separate byte and query-size budgets documented in [Persistent Storage](./persistent-storage.md#cache-retention-controls).

The defaults are:

| Store            | Limit        | Default |
| ---------------- | ------------ | ------- |
| Collection Store | `maxItems`   | `5000`  |
| List Query Store | `maxItems`   | `5000`  |
| List Query Store | `maxQueries` | `1000`  |

## Eviction model

TSDF evicts inactive entries in least-recently-used order. Hook reads, explicit fetches, and local item/query access keep entries fresh.

Entries are protected while they are actively mounted or doing work:

- mounted hook items and queries
- loading, refetching, or loading-more entries
- entries with an in-flight fetch
- entries with an in-flight mutation

Eviction is scheduled after state changes that can push the store over its configured limits. If every over-limit entry is protected, TSDF keeps the protected entries until they become inactive, then enforces the limit again.

## Collection store behavior

`CollectionStore` evicts inactive item entries when `maxItems` is exceeded.

```ts
const productStore = createCollectionStore<Product, string>({
  id: 'collection-products',
  storeManager,
  fetchFn: (productId, signal) => api.getProduct(productId, signal),
  maxItems: 1000,
  onStateCleanup: ({ reason, itemKeys, payloads }) => {
    console.log(reason, itemKeys, payloads);
  },
});
```

When items are evicted, TSDF also cleans their per-item scheduler and invalidation metadata. A later hook or fetch for the same payload behaves like a cold read unless persistent storage can hydrate it.

## List query store behavior

`ListQueryStore` has two related limits:

- `maxQueries` evicts inactive query entries in least-recently-used order.
- `maxItems` limits the shared item cache used by both list queries and standalone item hooks.

When item pressure is caused by items referenced by old queries, TSDF may evict whole inactive queries first. This avoids keeping a cached query whose item list is only partially available. After query eviction, orphan items that are no longer referenced by any query can be removed.

Standalone item entries can also be evicted directly when they are inactive and not referenced by any cached query.

```ts
const taskStore = createListQueryStore<Task, TaskFilter, string>({
  id: 'list-query-tasks',
  storeManager,
  fetchListFn: (filter, size, { signal }) => api.getTasks(filter, size, signal),
  fetchItemFn: (taskId, { signal }) => api.getTask(taskId, signal),
  maxItems: 2000,
  maxQueries: 250,
  onStateCleanup: ({ reason, itemPayloads, queryPayloads }) => {
    console.log(reason, { itemPayloads, queryPayloads });
  },
});
```

## Cleanup callbacks

Use `onStateCleanup` when app-level resources are keyed to cached TSDF state and should be released after eviction.

`CollectionStore` receives:

```ts
type CollectionStateCleanup<ItemPayload> = {
  reason: 'cacheLimitEviction';
  itemKeys: string[];
  payloads: ItemPayload[];
};
```

`ListQueryStore` receives:

```ts
type ListQueryStateCleanup<QueryPayload, ItemPayload> = {
  reason: 'cacheLimitEviction';
  itemKeys: string[];
  itemPayloads: ItemPayload[];
  queryKeys: string[];
  queryPayloads: QueryPayload[];
};
```

The callback is notification-only. The affected entries have already been removed from in-memory state by the time it runs.
