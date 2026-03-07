# Browser Tabs Sync

TSDF can keep data and fetch activity synchronized across tabs and windows, reducing duplicate network requests and keeping UI state consistent.

## Activation requirements

Browser tabs sync is available when all of these are true:

- All tabs use the same `id` for the same store
- `getSessionKey()` returns the same string in all tabs
- Tab communication is available (default: `BroadcastChannel`)

If `getSessionKey` returns `false`, sync is disabled for that store instance.

## What gets synchronized

- `fetch-start` and `fetch-success` messages for fetch batches
- successful fetch snapshots (document, collection item, list query/query+item)
- local state updates and optimistic mutation updates

Tabs use a versioned message model so later snapshots do not overwrite fresher remote state.

## Behavior details

- Tab status messages include focus and heartbeat data.
- Focused tabs keep the base `baseCoalescingWindowMs`.
- Background tabs are ranked and may receive an extended coalescing window (`base` + rank \* `1000ms`), which helps avoid duplicate background refetch work.
- `fetch-start` messages let sibling tabs drop duplicate scheduled work when another tab is already fetching the same request IDs.
- Confirmed snapshots from one tab are only applied to others when remote ordering says they are newer than the current version.

## Isolation

- Same `id` with different `sessionKey` values do not sync.
- Different `id` values do not sync.
- When `sessionKey` changes (for example, login/logout), sync state is refreshed for the new session.
- If transport is unavailable, sync becomes inactive silently.

## Required options

Add the following options to any store that should sync:

```ts
const store = createDocumentStore({
  id: 'document-store',
  getSessionKey: () => {
    return isLoggedIn ? `tenant:${tenantId}` : false;
  },
  /* ... */
});
```

The same keys are used by `createCollectionStore` and `createListQueryStore`.

See also: [Fetch Scheduling](./fetch-scheduling.md), where background tab focus ranking is integrated with coalescing.
