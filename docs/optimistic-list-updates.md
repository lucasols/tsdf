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

      // Trigger background revalidation when items are moved
      invalidateQueries: true,
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
- When `filterItem` returns `null`, the rule is skipped for that item

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

When `true`, queries affected by the optimistic update are invalidated in the background. This ensures the server's actual ordering/filtering is fetched eventually.

```ts
invalidateQueries: true;
```

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
});

const taskStore = createListQueryStore<Task, { status: string }, string>({
  id: 'tasks',
  storeManager,
  fetchListFn: (filter, size, { signal }) => api.getTasks(filter, size, signal),
  fetchItemFn: (id, { signal }) => api.getTask(id, signal),
  lowPriorityThrottleMs: 2000,
  baseCoalescingWindowMs: 100,
  blockWindowClose: null,

  optimisticListUpdates: [
    {
      // Move tasks between status columns
      queries: (q) => true,
      filterItem: (item) => item.status === 'todo',
      // Only applies to queries where status matches
    },
    {
      queries: { status: 'todo' },
      filterItem: (item) => item.status === 'todo',
      appendNewTo: 'start',
      invalidateQueries: true,
    },
    {
      queries: { status: 'done' },
      filterItem: (item) => item.status === 'done',
      appendNewTo: 'end',
      invalidateQueries: true,
    },
  ],
});

// When a task is moved to "done", it's automatically:
// 1. Removed from the "todo" query
// 2. Added to the "done" query
// 3. Both queries are revalidated in the background
taskStore.updateItemState('task-1', (draft) => {
  draft.status = 'done';
});
```
