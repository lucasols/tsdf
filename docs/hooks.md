# React Hooks

All TSDF stores provide React hooks that automatically manage data fetching, subscriptions, and re-rendering. Hooks trigger fetches on mount and respond to invalidation events.

## Common Hook Behaviors

All hooks share these behaviors:

- **Auto-fetch on mount**: When a hook mounts, it schedules a fetch based on the store's current state
- **Refetch on invalidation**: When data is invalidated, mounted hooks automatically refetch
- **Deep equality**: Hook return values use deep equality comparison to prevent unnecessary re-renders
- **Disabled state**: Passing a falsy payload (`null`, `undefined`, `false`) disables the hook — no fetch is triggered and the status is `idle`

## Common Hook Options

These options are available across all data hooks:

| Option                     | Default                                                   | Behavior                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disabled` / `isOffScreen` | `false`                                                   | When `true`, the hook does not trigger any fetches or respond to invalidation. Also respects the [IsOffScreenContext](./shared-types.md#isoffscreencontext) |
| `disableRefetches`         | `false`                                                   | Only fetches data if it has never been loaded (status is `idle` or `error`). Skips all refetches, even from invalidation                                    |
| `disableRefetchOnMount`    | `false` (or `true` when `usesRealTimeUpdates` is enabled) | Only fetches if data was explicitly invalidated or has never been loaded. Skips the low-priority refetch that normally happens on mount                     |
| `returnIdleStatus`         | `true` when disabled, `false` otherwise                   | When `false`, maps `idle` status to `loading` so the UI shows a loading state immediately                                                                   |
| `returnRefetchingStatus`   | `false`                                                   | When `false`, maps `refetching` status to `success` so the UI doesn't flicker during background refetches                                                   |
| `ensureIsLoaded`           | `false`                                                   | Forces a high-priority fetch on mount and overrides status to `loading` until data is loaded. Useful for components that must show fresh data               |

## `debouncePayload`

Payload-based hooks support `debouncePayload` to debounce automatic fetches
caused by rapid payload changes.

This applies to:

- `useItem`
- `useListQuery`
- `useMultipleItems`
- `useMultipleListQueries`

Behavior:

- The hook still reads from state using the latest payload immediately
- Only the automatic fetch side is delayed
- Cached data for the latest payload is still returned right away when present
- Intermediate payloads are skipped if they are replaced before the debounce
  window ends
- `useItem` and `useListQuery` throw if `debouncePayload` is combined with
  `ensureIsLoaded`

### Basic trailing debounce

```tsx
const result = store.useListQuery(filter, { debouncePayload: { ms: 200 } });
```

This waits `200ms` after the last payload change before fetching.

### `leading`

```tsx
const result = store.useItem(itemId, {
  debouncePayload: { ms: 300, leading: true },
});
```

With `leading: true`:

- The first payload in a burst may fetch immediately
- Later payload changes inside the same burst stay debounced
- When the debounce window ends, TSDF fetches the latest payload

### `maxWait`

```tsx
const result = store.useListQuery(filter, {
  debouncePayload: { ms: 300, maxWait: 1000 },
});
```

`maxWait` limits how long a burst may stay deferred. Even if payload changes
keep happening inside the debounce window, TSDF fetches the latest payload once
`maxWait` is reached.

## useDocument

**Store**: [Document Store](./document-store.md)

Returns the document data with loading/error states.

```tsx
const { data, status, error, isLoading } = store.useDocument();
```

### With selector

```tsx
const userName = store.useDocument({
  selector: (data) => data?.name ?? 'Unknown',
});
// userName.data is a string
```

### Disabling fetches

```tsx
// Don't refetch if already loaded
store.useDocument({ disableRefetches: true });

// Don't refetch on mount, only when invalidated
store.useDocument({ disableRefetchOnMount: true });

// Completely disable
store.useDocument({ disabled: true });
```

### Return value

- `data` - The selected data (or `null` if not loaded)
- `status` - `'idle'` | `'loading'` | `'success'` | `'error'` | `'refetching'`
- `error` - The `StoreError` if the fetch failed, otherwise `null`
- `isLoading` - Shorthand for `status === 'loading'`

## useItem

**Stores**: [Collection Store](./collection-store.md), [List Query Store](./list-query-store.md)

Fetches and subscribes to a single item by its payload.

```tsx
const { data, status, error, isLoading, payload } = store.useItem('item-id');
```

### Disabling with falsy payload

```tsx
// Disabled when productId is null/undefined/false — no fetch triggered
const product = store.useItem(productId ?? null);
```

### Empty string payload

Passing an empty string `''` as payload returns an immediate error state with `{ code: 461, id: 'invalid-payload' }` without triggering a fetch.

### With selector

```tsx
const itemName = store.useItem('item-1', { selector: (data) => data?.name });
```

### Debouncing payload changes

```tsx
const item = store.useItem(selectedItemId, {
  debouncePayload: { ms: 250, leading: true, maxWait: 1000 },
});
```

This is useful when `selectedItemId` changes rapidly, such as typeahead-driven
selection or fast keyboard navigation.

`ensureIsLoaded` cannot be combined with `debouncePayload` on single hooks.

### List Query Store specific options

- `loadFromStateOnly` - Don't fetch; return a cache-miss error (`{ code: 460, id: 'cache-miss' }`) if the item isn't already in the store
- `fields` - When [Partial Resources](./partial-resources.md) is enabled, specifies which fields to fetch

### Return value

- `data` - The selected data (or `null`)
- `status` - `'idle'` | `'loading'` | `'success'` | `'error'` | `'refetching'` | `'deleted'`
- `error` - The `StoreError` if the fetch failed
- `isLoading` - Shorthand for `status === 'loading'`
- `payload` - The resolved payload
- `itemStateKey` - The internal key for this item
- `queryMetadata` - Optional metadata passed via `useMultipleItems`

The `'deleted'` status is returned when the item's state is explicitly set to `null` (via `deleteItemState`).

## useListQuery

**Store**: [List Query Store](./list-query-store.md)

Fetches and subscribes to a paginated list query.

```tsx
const { items, status, hasMore, isLoading, isLoadingMore } = store.useListQuery(
  { projectId: 'proj-1', status: 'active' },
);
```

### Disabling with falsy payload

```tsx
// Disabled when filter is null
const result = store.useListQuery(filter ?? null);
```

### With item selector

Transform each item in the list:

```tsx
const result = store.useListQuery(filter, {
  itemSelector: (item) => ({ id: item.id, label: item.name }),
});
// result.items is { id: string; label: string }[]
```

### Custom load size

```tsx
store.useListQuery(filter, { loadSize: 20 }); // override defaultQuerySize
```

### Debouncing query changes

```tsx
const result = store.useListQuery(
  { search, status: 'open' },
  { debouncePayload: { ms: 300, maxWait: 1200 } },
);
```

`ensureIsLoaded` cannot be combined with `debouncePayload` on `useListQuery`.

This is useful for search forms and filter panels where the query payload
changes on every keystroke.

### Return value

- `items` - Array of items (or selected items)
- `status` - `'idle'` | `'loading'` | `'success'` | `'error'` | `'refetching'` | `'loadingMore'`
- `loadingFields` - Requested partial-resource fields still pending while cached data remains visible
- `hasMore` - Whether more items are available for pagination
- `isLoading` - Shorthand for `status === 'loading'`
- `isLoadingMore` - Shorthand for `status === 'loadingMore'`
- `error` - The `StoreError` if the fetch failed
- `payload` - The resolved payload
- `queryKey` - The internal key for this query

## useMultipleItems

**Stores**: [Collection Store](./collection-store.md), [List Query Store](./list-query-store.md)

Fetches and subscribes to multiple items. Each item can have its own options.

```tsx
const items = store.useMultipleItems([
  { payload: 'item-1' },
  { payload: 'item-2', disableRefetches: true },
  { payload: 'item-3', isOffScreen: true },
]);
// items[0].data, items[1].data, etc.
```

Per-item options override the global options passed to the hook.

You can debounce automatic fetches for rapid item-array changes:

```tsx
const items = store.useMultipleItems(
  selectedIds.map((payload) => ({ payload })),
  { debouncePayload: { ms: 150 } },
);
```

## useMultipleListQueries

**Store**: [List Query Store](./list-query-store.md)

Fetches and subscribes to multiple list queries.

```tsx
const queries = store.useMultipleListQueries([
  { payload: { projectId: 'proj-1' } },
  { payload: { projectId: 'proj-2' }, loadSize: 10 },
]);
// queries[0].items, queries[1].items, etc.
```

You can debounce automatic fetches for rapid query-array changes:

```tsx
const queries = store.useMultipleListQueries(queryInputs, {
  debouncePayload: { ms: 200, maxWait: 1000 },
});
```

## useFindItem

**Store**: [List Query Store](./list-query-store.md)

Finds a single item across all items in the store by a predicate. Does not trigger any fetch — only searches the existing state.

```tsx
const activeTask = store.useFindItem((item) => item.isActive, {
  selector: (item) => item.title,
});
// activeTask is string | null
```

## useListItem Hooks

These hooks detect loading and deletion states for sub-items within a store's data. Useful when a document or collection item contains a nested list, and you need to display individual items from that list.

Available on: [Document Store](./document-store.md), [Collection Store](./collection-store.md)

### useListItemIsLoading

Returns `true` if a sub-item is still loading.

```tsx
const isLoading = store.useListItemIsLoading({
  itemId: 'sub-item-1',
  selector: (data) => data?.subItems?.find((i) => i.id === 'sub-item-1'),
});
```

Behavior:

1. If the sub-item exists in the data, returns `false`
2. If the sub-item is missing and the parent data is still loading, returns `true`
3. After 100ms timeout, if the sub-item is still missing and no refetch is in progress, calls `loadItemFallback` (defaults to `invalidateData()` / `invalidateItem()`)
4. After 1000ms, stops showing loading to prevent infinite loading states

### useListItemIsDeleted

Returns `true` when a sub-item that previously existed disappears from the data (not during initial loading).

```tsx
const isDeleted = store.useListItemIsDeleted({
  itemId: 'sub-item-1',
  selector: (data) => data?.subItems?.find((i) => i.id === 'sub-item-1'),
  onDelete: () => navigate('/list'),
});
```

### useListItem

Combines `useListItemIsLoading` and `useListItemIsDeleted`:

```tsx
const { isLoading, isDeleted, data } = store.useListItem({
  itemId: 'sub-item-1',
  selector: (data) => data?.subItems?.find((i) => i.id === 'sub-item-1'),
  onDelete: () => navigate('/list'),
});
```

For Collection Store, these hooks take the item payload as the first argument:

```tsx
const { isLoading, isDeleted, data } = collectionStore.useListItem(
  'item-payload',
  {
    itemId: 'sub-item-1',
    selector: (data) => data?.nested?.find((i) => i.id === 'sub-item-1'),
  },
);
```
