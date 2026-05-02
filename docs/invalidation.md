# Invalidation

Invalidation marks data as stale, causing mounted hooks to refetch and future hook mounts to trigger fresh fetches. TSDF provides granular invalidation control across all store types.

## How Invalidation Works

When data is invalidated:

1. The `refetchOnMount` flag is set to the invalidation priority on the affected data
2. An invalidation event is emitted
3. Any currently mounted hooks listening for that event schedule a refetch at the specified priority
4. If no hooks are mounted, the `refetchOnMount` flag ensures the next mount triggers a fetch

Multiple invalidations are coalesced: if data already has a pending invalidation at the same or higher priority, the new invalidation is skipped.

## Document Store

```ts
// Invalidate with high priority (default)
store.invalidateData();

// Invalidate with specific priority
store.invalidateData('lowPriority');
store.invalidateData('realtimeUpdate');
```

## Collection Store

```ts
// Single item
store.invalidateItem('item-1');

// Multiple items
store.invalidateItem(['item-1', 'item-2']);

// By filter
store.invalidateItem((payload, data) => data?.category === 'electronics');

// With specific priority
store.invalidateItem('item-1', 'lowPriority');
```

## List Query Store

The List Query Store has the most flexible invalidation through `invalidateQueryAndItems`:

```ts
import { ALL_QUERY_AND_ITEMS, GET_ALL } from 'tsdf';

// Invalidate all queries and all items
store.invalidateQueryAndItems(ALL_QUERY_AND_ITEMS);

// Invalidate specific queries only (skip items)
store.invalidateQueryAndItems({
  queryPayload: { projectId: 'proj-1' },
  itemPayload: false,
});

// Invalidate specific items only (skip queries)
store.invalidateQueryAndItems({
  queryPayload: false,
  itemPayload: ['task-1', 'task-2'],
});

// Invalidate by filter
store.invalidateQueryAndItems({
  queryPayload: (query) => query.status === 'active',
  itemPayload: (item, payload) => item.priority > 5,
  type: 'lowPriority',
});

// Reuse the all-payload predicate with one side disabled
store.invalidateQueryAndItems({ queryPayload: GET_ALL, itemPayload: false });
```

### Item-only invalidation

```ts
// Shorthand for invalidating only items (no queries)
store.invalidateItem('task-1');
store.invalidateItem(['task-1', 'task-2']);
store.invalidateItem((item, payload) => item.stale);
```

Note: `invalidateItem` requires `fetchItemFn` to be configured. Without it, item invalidation is a no-op.

### Per-field Invalidation

When [Partial Resources](./partial-resources.md) is enabled, you can invalidate specific fields:

```ts
store.invalidateQueryAndItems({
  queryPayload: false,
  itemPayload: 'task-1',
  fields: ['name', 'description'], // only these fields are refetched
});
```

This removes the specified fields from the item's loaded fields tracking, causing hooks requesting those fields to refetch them.

## Invalidation Priority

Invalidation respects the [fetch priority system](./fetch-scheduling.md):

| Priority         | Typical use                                   |
| ---------------- | --------------------------------------------- |
| `highPriority`   | User action, explicit refresh (default)       |
| `lowPriority`    | Window focus revalidation, background updates |
| `realtimeUpdate` | WebSocket push notifications                  |

If data already has a pending invalidation at equal or higher priority, a new invalidation at a lower priority is ignored.

## Interaction with Hooks

### disableRefetches

When a hook has `disableRefetches: true`, it ignores invalidation events **unless** the store status is `idle` or `error`. This means the hook only fetches on initial load or after errors.

### disableRefetchOnMount

When a hook has `disableRefetchOnMount: true`, it only fetches when:

- The data has never been loaded (`status === 'idle'`)
- The data was explicitly invalidated (`refetchOnMount` is set)

It skips the default low-priority fetch that normally occurs on every mount.

## Automatic Invalidation

TSDF automatically invalidates data in these scenarios:

- **Mutation error**: After a failed mutation, affected data is invalidated to revert optimistic updates
- **Mutation success with `revalidateOnSuccess`**: Affected data is invalidated to fetch the server's actual state
- **Window focus**: When `revalidateOnWindowFocus` is enabled, all data is invalidated with `lowPriority`
- **Transport reconnect**: When `onTransportReconnect()` is called, all data is invalidated with `realtimeUpdate` priority. See [Real-Time Updates](./real-time-updates.md)
