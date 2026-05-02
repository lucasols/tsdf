# List Query Store

The most feature-rich store type. It manages paginated lists (queries) combined with individual item queries. Items are shared across queries, so updating an item in one query automatically reflects in all other queries that reference it.

See also: [Hooks](./hooks.md) | [Mutations](./mutations.md) | [Invalidation](./invalidation.md) | [Optimistic List Updates](./optimistic-list-updates.md) | [Partial Resources](./partial-resources.md) | [Offset Pagination](./offset-pagination.md) | [Batch Fetching](./batch-fetching.md) | [Persistent Storage](./persistent-storage.md) | [Offline](./offline.md)

## Creating a List Query Store

```ts
import { createListQueryStore, createStoreManager } from 'tsdf';

type Task = {
  id: string;
  title: string;
  status: 'todo' | 'done';
  priority: number;
};
type TaskFilter = { status?: 'todo' | 'done'; projectId: string };
const storeManager = createStoreManager({
  getSessionKey: () =>
    authState.userId ? `tenant:${authState.tenantId}` : false,
  errorNormalizer: normalizeError,
  lowPriorityThrottleMs: 5,
  baseCoalescingWindowMs: 10,
  blockWindowClose: null,
});

const taskStore = createListQueryStore<Task, TaskFilter, string>({
  id: 'list-query-tasks',
  storeManager,
  fetchListFn: (filter, size, { signal }) => api.getTasks(filter, size, signal),
  fetchItemFn: (taskId, { signal }) => api.getTask(taskId, signal),
});
```

The type parameters are:

- `ItemState` - The shape of each item
- `QueryPayload` - The payload that identifies a query (e.g., filter params)
- `ItemPayload` - The payload that identifies an individual item (e.g., item ID)
- `TPartialResources` (optional, `boolean`) - Enables [Partial Resources](./partial-resources.md)
- `TOffsetPagination` (optional, `boolean`) - Enables [Offset Pagination](./offset-pagination.md)

## Options

### Required Options

| Option         | Type                                                                | Description                                                                             |
| -------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `id`           | `string`                                                            | Stable logical store id shared across tabs                                              |
| `storeManager` | `StoreManager`                                                      | Shared global config with `getSessionKey`, `errorNormalizer`, and global store controls |
| `fetchListFn`  | Size mode: `(payload, size, options) => Promise<FetchListFnReturn>` | Fetches a paginated list. See [Pagination modes](#pagination-modes)                     |

### Optional Options

| Option                         | Type                                                                     | Description                                                                          |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `lowPriorityThrottleMs`        | `number`                                                                 | Overrides the manager default. See [Fetch Scheduling](./fetch-scheduling.md)         |
| `baseCoalescingWindowMs`       | `number`                                                                 | Overrides the manager default. See [Fetch Scheduling](./fetch-scheduling.md)         |
| `fetchItemFn`                  | `(payload, options: { signal, fields? }) => Promise<ItemState>`          | Fetches a single item. Required for `useItem`, `invalidateItem`, `scheduleItemFetch` |
| `batchFetchItemFn`             | `(requests, options) => Promise<Map<ItemPayload, ItemState \| Error>>`   | See [Batch Fetching](./batch-fetching.md)                                            |
| `getItemsBatchKey`             | `(payload: ItemPayload) => string \| false`                              | See [Batch Fetching](./batch-fetching.md)                                            |
| `defaultQuerySize`             | `number`                                                                 | Default page size (default: `50`)                                                    |
| `maxItemBatchSize`             | `number`                                                                 | Max items per batch fetch                                                            |
| `maxItems`                     | `number`                                                                 | Maximum cached items kept in memory. Defaults to `5000`                              |
| `maxQueries`                   | `number`                                                                 | Maximum cached queries kept in memory. Defaults to `1000`                            |
| `onStateCleanup`               | `(cleanup) => void`                                                      | Called when memory cache eviction removes items or queries                           |
| `optimisticListUpdates`        | `OptimisticListUpdate[]`                                                 | See [Optimistic List Updates](./optimistic-list-updates.md)                          |
| `partialResources`             | `PartialResourcesConfig`                                                 | See [Partial Resources](./partial-resources.md)                                      |
| `derivedQueries`               | `DerivedQueriesConfig`                                                   | Derive hook results from local items instead of fetching when possible               |
| `offsetPagination`             | `OffsetPaginationConfig`                                                 | See [Offset Pagination](./offset-pagination.md)                                      |
| `getQueryKey`                  | `(params) => ValidPayload \| unknown[]`                                  | Custom query key derivation                                                          |
| `getItemKey`                   | `(params) => ValidPayload \| unknown[]`                                  | Custom item key derivation                                                           |
| `mediumPriorityDelayMs`        | `number`                                                                 | Delay before medium-priority fetches execute                                         |
| `dynamicRealtimeThrottleMs`    | `(params) => number`                                                     | See [Real-Time Updates](./real-time-updates.md)                                      |
| `revalidateOnWindowFocus`      | `boolean \| (() => boolean)`                                             | Refetch on window focus                                                              |
| `transportReconnectCooldownMs` | `number`                                                                 | Cooldown for repeated transport reconnect revalidation                               |
| `usesRealTimeUpdates`          | `boolean`                                                                | See [Real-Time Updates](./real-time-updates.md)                                      |
| `onInvalidateQuery`            | `(query, priority) => void`                                              | Called when a query is invalidated                                                   |
| `onInvalidateItem`             | `(props: { itemState, payload, priority }) => void`                      | Called when an item is invalidated                                                   |
| `persistentStorage`            | `ListQueryPersistentStorageConfig<ItemState, QueryPayload, ItemPayload>` | Configure cache persistence. See [Persistent Storage](./persistent-storage.md)       |
| `onSchedulerEvent`             | `(event, data?) => void`                                                 | Scheduler event listener                                                             |
| `onMutationError`              | `(error, options) => void`                                               | Global mutation error handler                                                        |

### FetchListFnReturn

The `fetchListFn` must return:

```ts
type FetchListFnReturn<ItemState, ItemPayload> = {
  items: { itemPayload: ItemPayload; data: ItemState }[];
  hasMore: boolean;
};
```

### Pagination Modes

**Size mode (default):**

```ts
fetchListFn: (payload, size, { signal, fields? }) => Promise<FetchListFnReturn>
```

**Offset mode** (when `offsetPagination` is set):

```ts
fetchListFn: (payload, { offset, limit }, { signal, fields? }) => Promise<FetchListFnReturn>
```

See [Offset Pagination](./offset-pagination.md) for details.

## State Shape

```ts
type TSFDListQueryState<ItemState, QueryPayload, ItemPayload> = {
  items: Record<string, ItemState | null>;
  queries: Record<string, TSFDListQuery<QueryPayload>>;
  itemQueries: Record<string, TSDFItemQuery<ItemPayload> | null>;
  itemLoadedFields: Record<string, string[]>;
  itemFieldInvalidationFields: Record<string, string[]>;
};
```

### Query State

```ts
type TSFDListQuery<QueryPayload> = {
  error: StoreError | null;
  status: 'loading' | 'error' | 'refetching' | 'success' | 'loadingMore';
  payload: QueryPayload;
  hasMore: boolean;
  wasLoaded: boolean;
  refetchOnMount:
    | false
    | 'lowPriority'
    | 'mediumPriority'
    | 'realtimeUpdate'
    | 'highPriority';
  items: string[]; // Array of item keys
};
```

### Item Query State

```ts
type TSDFItemQuery<ItemPayload> = {
  error: StoreError | null;
  status: 'loading' | 'error' | 'refetching' | 'success';
  wasLoaded: boolean;
  refetchOnMount:
    | false
    | 'lowPriority'
    | 'mediumPriority'
    | 'realtimeUpdate'
    | 'highPriority';
  payload: ItemPayload;
};
```

Key points:

- `items` stores the actual data, shared across queries
- `queries` stores query metadata and an ordered list of item keys
- `itemQueries` stores per-item fetch metadata (for `fetchItemFn`)
- `itemLoadedFields` / `itemFieldInvalidationFields` are used by [Partial Resources](./partial-resources.md)
- Derived query results are hook-level computed views only; they are not stored in `queries`

## Derived Queries

`derivedQueries` lets hooks resolve a list query from locally materialized items
instead of fetching when the store can produce a reliable result.

```ts
derivedQueries: {
  getQueryGroup: (queryPayload) => queryPayload.tableId,
  getItemGroup: (_item, itemPayload) => itemPayload.split('||')[0] ?? '',
  isComplete: (queryPayload, { queries }) => queries.length > 0,
  deriveQuery: (queryPayload, items, { fields, isOfflineMode, deriveSource }) => {
    if (Array.isArray(fields) && fields.includes('age')) {
      return false;
    }

    return items.map(({ key }) => key);
  },
}
```

Behavior:

- Online: exact query cache wins; otherwise TSDF can derive when `isComplete(...)` returns `true`
- Offline: derivation is attempted before the exact cached query result
- `deriveQuery(...)` receives `{ fields, isOfflineMode, deriveSource }`
- `fields` lets derivation opt out of partial-resource queries when local data is insufficient
- `deriveSource` is `'online'`, `'offline'`, or `'sticky-offline'`
- Derived results expose `isDerived: true`
- Derived results always expose `hasMore: false`
- Derived results do not create `state.queries[queryKey]`

## API

### Hooks

| Hook                                        | Description                                | Details                                                                 |
| ------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| `useListQuery(payload, options?)`           | Fetch and subscribe to a list query        | See [Hooks - useListQuery](./hooks.md#uselistquery)                     |
| `usePendingOfflineItems(options?)`          | Read queued offline items without fetching | See [Hooks - usePendingOfflineItems](./hooks.md#usependingofflineitems) |
| `useMultipleListQueries(queries, options?)` | Fetch multiple list queries                | See [Hooks - useMultipleListQueries](./hooks.md#usemultiplelistqueries) |
| `useItem(payload, options?)`                | Fetch and subscribe to a single item       | See [Hooks - useItem](./hooks.md#useitem)                               |
| `useMultipleItems(items, options?)`         | Fetch multiple individual items            | See [Hooks - useMultipleItems](./hooks.md#usemultipleitems)             |
| `useFindItem(findFn, options?)`             | Find an item by predicate across all items | See [Hooks - useFindItem](./hooks.md#usefinditem)                       |

### Query Methods

| Method                    | Signature                                                               | Description                                                  |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| `scheduleListQueryFetch`  | `(fetchType, payload(s), size?, options?) => ScheduleFetchResults`      | Schedule a list fetch                                        |
| `awaitListQueryFetch`     | `(params, options?) => Promise<{ items, error, hasMore }>`              | Await a list fetch                                           |
| `preloadQueryFromStorage` | `(payloads) => Promise<PersistentStoragePreloadResult<QueryPayload>[]>` | Preload cached list query payloads from async storage (OPFS) |
| `loadMore`                | `(params, size?, options?) => ScheduleFetchResults`                     | Load more items (pagination)                                 |
| `getQueryState`           | `(params) => TSFDListQuery`                                             | Get query state                                              |
| `getQueryKey`             | `(params) => string`                                                    | Get composite key for a query payload                        |
| `getQueriesState`         | `(params) => { query, key }[]`                                          | Get multiple query states                                    |
| `getQueriesRelatedToItem` | `(itemPayload) => TSFDListQuery[]`                                      | Find queries containing an item                              |

### Item Methods

| Method                   | Signature                                                            | Description                                         |
| ------------------------ | -------------------------------------------------------------------- | --------------------------------------------------- |
| `scheduleItemFetch`      | `(fetchType, payload(s), options?) => ScheduleFetchResults`          | Schedule an item fetch                              |
| `awaitItemFetch`         | `(itemPayload, options?) => Promise<{ data, error }>`                | Await an item fetch                                 |
| `preloadItemFromStorage` | `(params) => Promise<PersistentStoragePreloadResult<ItemPayload>[]>` | Preload cached list items from async storage (OPFS) |
| `getItemKey`             | `(params) => string`                                                 | Get composite key for an item payload               |
| `getItemState`           | `(payload) => ItemState \| null`                                     | Get item data                                       |

### Offline Methods

| Method                                                | Description                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| `getOfflineEntities()` / `useOfflineEntities()`       | Read offline entities scoped to this store                        |
| `getOfflineResolutions()` / `useOfflineResolutions()` | Read manual conflict/retry resolutions scoped to this store       |
| `parseOfflineResolutionConflict(resolution)`          | Narrow a persisted resolution to this store's operation types     |
| `resolveOfflineResolution(id, operation, action)`     | Resolve, retry, discard, requeue, or commit an offline resolution |

### Offline Queue Hook

`usePendingOfflineItems(options?)` is the list-query-store hook for reading the
store's pending offline item state directly.

Use it when:

- you need queued offline items even if no query is mounted
- you want pending deletes separately from visible pending items
- you want offline queue UI without triggering fetches

Unlike `useListQuery(...)`, it does not load query results or expose query
status. It derives data from the offline queue, overlays, live store state,
and persisted item snapshots, using the precomputed offline entity lifecycle
kind so pending deletes do not need item hydration before they appear.

### Mutation Methods

| Method                                          | Description                                                                               | Details                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------- |
| `invalidateQueryAndItems(options)`              | Invalidate queries and/or items                                                           | See [Invalidation](./invalidation.md) |
| `invalidateItem(payload(s), priority?)`         | Invalidate item(s) only                                                                   | See [Invalidation](./invalidation.md) |
| `updateItemState(itemIds, produceFn, options?)` | Immer-based item update + applies [Optimistic List Updates](./optimistic-list-updates.md) |
| `addItemToState(itemPayload, data, options?)`   | Add an item with optional query placement                                                 |
| `deleteItemState(itemId)`                       | Delete item from all queries                                                              |
| `startItemMutation(itemId)`                     | Start mutation lock on item + related queries                                             |
| `performMutation(payload, options)`             | Full mutation lifecycle. See [Mutations](./mutations.md)                                  |

### Other

| Method                   | Description                                     |
| ------------------------ | ----------------------------------------------- |
| `reset()`                | Full reset of all state and schedulers          |
| `onTransportReconnect()` | See [Real-Time Updates](./real-time-updates.md) |

### Properties

| Property      | Type                                 | Description                                               |
| ------------- | ------------------------------------ | --------------------------------------------------------- |
| `store`       | `Store<TSFDListQueryState>`          | Underlying t-state store                                  |
| `events`      | `Emitter<ListQueryStoreEvents>`      | Invalidation events (`invalidateQuery`, `invalidateItem`) |
| `storeEvents` | `Emitter<ListQueryStoreStoreEvents>` | Mutation lifecycle events                                 |

## Usage Example

```tsx
// List view
function TaskList({ projectId }: { projectId: string }) {
  const { items, isLoading, hasMore, status } = taskStore.useListQuery({
    projectId,
    status: 'todo',
  });

  if (isLoading) return <Spinner />;

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
          onClick={() => taskStore.loadMore({ projectId, status: 'todo' })}
        >
          Load More
        </button>
      )}
    </div>
  );
}

// Item view (shares state with list)
function TaskDetail({ taskId }: { taskId: string }) {
  const { data, isLoading } = taskStore.useItem(taskId);

  if (isLoading) return <Spinner />;

  return <div>{data?.title}</div>;
}

// Add item to specific queries
taskStore.addItemToState('task-new', newTask, {
  addItemToQueries: {
    queries: { projectId: 'proj-1', status: 'todo' },
    appendTo: 'start',
  },
});
```

## addItemToState Options

```ts
addItemToState(itemPayload, data, {
  addItemToQueries?: {
    queries: QueryPayload[] | FilterQuery | QueryPayload;
    appendTo: 'start' | 'end' | ((itemsPayload: ItemPayload[]) => number);
  }
})
```

- `queries` - Which queries to add the item to
- `appendTo` - Where to insert: `'start'`, `'end'`, or a function returning the insertion index
