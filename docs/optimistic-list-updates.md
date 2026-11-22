# Optimistic List Updates

Optimistic list updates automatically keep list queries in sync when item state changes. When you update an item, the configured rules determine whether items should be added to, removed from, or re-sorted within queries — all without waiting for a server response.

**Store**: [List Query Store](./list-query-store.md) only.

## How It Works

When you call `updateItemState` or `addItemToState`, TSDF applies optimistic list update rules to the affected queries. These rules can:

1. **Filter items in/out of queries** based on item data
2. **Re-sort queries** based on updated item values
3. **Trigger background revalidation** of affected queries

## Configuration

Define rules when creating the store:

```ts
const taskStore = createListQueryStore<Task, TaskFilter, string>({
  // ...other options

  optimisticListUpdates: [
    {
      // Which queries this rule applies to
      queries: (query) => query.projectId != null,

      // Decide if an item should be in the query
      filterItem: (item) => item.status === 'active',

      // Where to add new items
      appendNewTo: 'start',
    },
    {
      // Sort a specific query by priority
      queries: { projectId: 'proj-1', status: 'active' },
      sort: { sortBy: (item) => item.priority, order: 'desc' },
    },
  ],
});
```

## Rule Options

### queries

Specifies which queries this rule applies to:

```ts
// Single query
queries: {
  projectId: 'proj-1';
}

// Multiple queries
queries: [{ projectId: 'proj-1' }, { projectId: 'proj-2' }];

// Filter function
queries: (queryPayload) => queryPayload.status === 'active';
```

### filterItem

Decides whether an item should be included in matching queries:

```ts
filterItem: (item) => {
  // true  → item should be in the query (add if missing)
  // false → item should NOT be in the query (remove if present)
  // null  → skip this rule for this item (no change)
  return item.status === 'active';
};
```

- When `filterItem` returns `true` and the item is not in the query, it's added at the position specified by `appendNewTo`
- When `filterItem` returns `false` and the item is in the query, it's removed
- When `filterItem` returns `null`, the rule is skipped for that item in that query
- When `filterItem` returns `true` for a query that is not in memory, the query is created with only the item, and refetched when it is used. With [persistent storage](./persistent-storage.md) the query is left as is instead: its saved copy (not read yet, being read, or evicted from memory) would be replaced by a list with only the item. A rule whose `queries` is a filter reads saved queries back first, so with a sync adapter such as `local-sync` they are in memory again and get the item right away. A query restored from storage is refetched when it is used (after the mutation settles), which adds the item. Offline, the restored query only shows the item once the queued change is sent and the store revalidates

`filterItem` is called once for each matching query and receives a context object as second argument:

| Field             | Description                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queryPayload`    | Payload of the query being evaluated                                                                                                                                    |
| `itemPayload`     | Payload of the item being evaluated                                                                                                                                     |
| `isInQuery`       | Whether the item is in the query right before the rule is applied. Computed on first read; read it while `filterItem` is running                                        |
| `previousItem`    | Item state before the `updateItemState` / `addItemToState` call, or `null` when the item was not in the store                                                           |
| `previousQueries` | Payloads of the cached queries that listed the item before the `updateItemState` / `addItemToState` call. Computed on first read; read it while `filterItem` is running |

With the query payload, one rule can decide membership for every query, instead of one rule per filter combination:

```ts
optimisticListUpdates: [
  {
    queries: () => true,
    filterItem: (task, { queryPayload }) =>
      taskBelongsToQuery(task, queryPayload),
  },
];
```

Return `null` for queries whose filters depend on data the client cannot evaluate (server-side search, permissions). `isInQuery` tells if the item already passed those filters on the server:

```ts
filterItem: (task, { queryPayload, isInQuery }) => {
  const matchesLocalFilters = taskMatchesLocalFilters(task, queryPayload);

  if (!queryPayload.search) return matchesLocalFilters;

  // In the query: it already matched the search, so only the local filters
  // can remove it. Not in the query: no way to know, keep as is.
  return isInQuery ? matchesLocalFilters : null;
};
```

`previousItem` and `previousQueries` tell what changed and where the item was before the update. An item that moved out of a query with the same server-side filters is known to pass them, so it can be added to the query of its new status:

```ts
filterItem: (
  task,
  { queryPayload, isInQuery, previousItem, previousQueries },
) => {
  const matchesLocalFilters = taskMatchesLocalFilters(task, queryPayload);

  if (!queryPayload.search || isInQuery) return matchesLocalFilters;

  // Only a status change moves the task between the lists
  if (!matchesLocalFilters || previousItem?.status === task.status) return null;

  const wasInSameSearch = previousQueries.some(
    (previousQuery) => previousQuery.search === queryPayload.search,
  );

  return wasInSameSearch ? true : null;
};
```

`previousQueries` only has the queries cached in memory, not the ones only in persistent storage.

### appendNewTo

Where to insert items when `filterItem` adds them to a query:

```ts
appendNewTo: 'start'; // prepend to the beginning
appendNewTo: 'end'; // append to the end (default)
```

### sort

Re-sorts the query's items after an update:

```ts
sort: {
  sortBy: (item, itemPayload) => item.priority,
  order: 'desc', // 'asc' | 'desc'
}
```

For multi-key sorting:

```ts
sort: {
  sortBy: (item) => [item.category, item.priority],
  order: ['asc', 'desc'],
}
```

Sorting is applied only to queries that contain the updated item.

### invalidateQueries

Schedules a background refetch of queries this rule mutated.

**Leave off by default.** Only enable when the optimistic update can't represent the final server state — e.g. sort depends on a server-assigned field (`updatedAt`, computed score), membership depends on server-only data (permissions, full-text match), or cursor pagination shifts the page window. If `filterItem` and `sort` already match the server, the extra refetch is just noise.

```ts
invalidateQueries: true;
```

With `invalidateQueries` enabled, a rule with `sort` refetches every matching query that contains the updated item on each update, even when the optimistic order did not change — the client can't tell whether the server order did.

## When Rules Are Applied

Optimistic list updates are triggered by:

1. **`updateItemState`** — After updating item data, all rules are evaluated for the updated items
2. **`addItemToState`** — After adding a new item, rules determine which queries should include it

They are **not** triggered by:

- `deleteItemState` (items are simply removed from all queries)
- Direct store mutations
- Fetch completions

## Example: Task Board

```ts
const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  errorNormalizer: normalizeError,
  lowPriorityThrottleMs: 40 * 60 * 1_000,
  baseCoalescingWindowMs: 16,
  blockWindowClose: null,
});

const taskStore = createListQueryStore<Task, { status: string }, string>({
  id: 'tasks',
  storeManager,
  fetchListFn: (filter, size, { signal }) => api.getTasks(filter, size, signal),
  fetchItemFn: (id, { signal }) => api.getTask(id, signal),

  optimisticListUpdates: [
    // Membership follows status — the optimistic change is final.
    {
      queries: { status: 'todo' },
      filterItem: (item) => item.status === 'todo',
      appendNewTo: 'start',
    },
    {
      queries: { status: 'done' },
      filterItem: (item) => item.status === 'done',
      appendNewTo: 'end',
    },
    // Server sorts by `updatedAt`, which it assigns — refetch to settle order.
    {
      queries: (q) => true,
      sort: { sortBy: (item) => item.updatedAt, order: 'desc' },
      invalidateQueries: true,
    },
  ],
});

// Moving "task-1" to done removes it from the todo query and adds it to the
// done query. Only the sort rule triggers a background refetch.
taskStore.updateItemState('task-1', (draft) => {
  draft.status = 'done';
});
```
