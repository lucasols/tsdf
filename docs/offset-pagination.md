# Offset Pagination

By default, List Query Store uses "size mode" pagination where the entire result set is re-fetched when loading more items. Offset pagination mode uses actual offset/limit-based pagination, which is more efficient for large datasets.

**Store**: [List Query Store](./list-query-store.md) only.

## Enabling Offset Pagination

Enable by setting the `TOffsetPagination` type parameter to `true` and providing an `offsetPagination` config:

```ts
const store = createListQueryStore<Task, TaskFilter, string, false, true>({
  //                                                               ^^^^ enables offset pagination

  // In offset mode, fetchListFn receives { offset, limit } instead of size
  fetchListFn: (filter, { offset, limit }, { signal }) => {
    return api.getTasks(filter, { offset, limit, signal });
  },

  offsetPagination: { maxInvalidationLimit: 200, maxParallel: 3 },

  // ...other options
});
```

## How It Works

### Size Mode (Default)

In size mode, `loadMore` re-fetches the entire range from 0 to the new total size:

```
Initial load: fetchListFn(filter, 50)     → items 0-49
Load more:    fetchListFn(filter, 100)    → items 0-99 (re-fetches everything)
Load more:    fetchListFn(filter, 150)    → items 0-149 (re-fetches everything)
```

### Offset Mode

In offset mode, `loadMore` fetches only the new items:

```
Initial load: fetchListFn(filter, { offset: 0, limit: 50 })    → items 0-49
Load more:    fetchListFn(filter, { offset: 50, limit: 50 })   → items 50-99 (new items only)
Load more:    fetchListFn(filter, { offset: 100, limit: 50 })  → items 100-149 (new items only)
```

New items are appended to the existing list.

## Chunked Invalidation

When a query with many loaded items is invalidated, fetching all items in a single request could be slow or hit API limits. Offset pagination handles this by splitting the invalidation into parallel chunks:

```
Query has 500 items loaded, maxInvalidationLimit = 200, maxParallel = 3

Chunk 1: fetchListFn(filter, { offset: 0, limit: 200 })
Chunk 2: fetchListFn(filter, { offset: 200, limit: 200 })
Chunk 3: fetchListFn(filter, { offset: 400, limit: 100 })

Chunks 1-3 run in parallel (up to maxParallel concurrent)
```

Results are deduplicated (in case of overlapping items) and combined into the final query state.

## Configuration

### maxInvalidationLimit

The maximum number of items to fetch in a single request during invalidation. When the loaded size exceeds this, the fetch is split into chunks.

### maxParallel

Maximum number of parallel chunk requests during chunked invalidation. Defaults to `3`.

## Loading More

```tsx
function TaskList() {
  const { items, hasMore, isLoadingMore } = store.useListQuery(filter);

  return (
    <div>
      {items.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
        />
      ))}

      {hasMore && (
        <button
          onClick={() => store.loadMore(filter)}
          disabled={isLoadingMore}
        >
          {isLoadingMore ? 'Loading...' : 'Load More'}
        </button>
      )}
    </div>
  );
}
```

You can specify a custom size for `loadMore`:

```ts
store.loadMore(filter, 25); // load 25 more items (instead of defaultQuerySize)
```
