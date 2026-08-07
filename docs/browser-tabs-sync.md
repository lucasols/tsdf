# Browser Tabs Sync

TSDF can keep data and fetch activity synchronized across tabs and windows, reducing duplicate network requests and keeping UI state consistent.

## Activation requirements

Browser tabs sync is available when all of these are true:

- All tabs use the same `id` for the same store
- `storeManager.getSessionKey()` returns the same string in all tabs
- If configured, the `createStoreManager({ getAppVersion })` callback returns the same build version in all tabs
- Tab communication is available (default: `BroadcastChannel`)

If `getSessionKey` returns `false`, sync is disabled for that store instance.

## What gets synchronized

- `fetch-start` and `fetch-success` messages for fetch batches
- successful fetch snapshots (document, collection item, list query/query+item)
- local state updates and optimistic mutation updates

Tabs use a versioned message model so later snapshots do not overwrite fresher remote state.

## Behavior details

- Tab status messages include focus and presence timestamp data.
- Focused tabs keep the base `baseCoalescingWindowMs`.
- Background tabs are ranked and may receive an extended coalescing window (`base` + `backgroundCoalescingDelayMs` + background rank \* `1000ms`), which helps avoid duplicate background refetch work. The first background tab uses rank `0`, so the default first background window is `base + 3000ms`.
- `fetch-start` messages let sibling tabs drop duplicate scheduled work when another tab is already fetching the same request IDs.
- Confirmed snapshots from one tab are only applied to others when remote ordering says they are newer than the current version.

## Isolation

- Same `id` with different `sessionKey` values do not sync.
- Different `id` values do not sync.
- Different values from the configured `getAppVersion` callback do not share any browser-tab sync channels.
- When `sessionKey` changes (for example, login/logout), sync state is refreshed for the new session.
- If transport is unavailable, sync becomes inactive silently.

Apps deployed while users may keep older tabs open should always provide `getAppVersion`. Return a stable release or build identifier that changes whenever a new bundle is deployed:

```ts
const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  getAppVersion: () => BUILD_VERSION,
  errorNormalizer: normalizeError,
});
```

TSDF evaluates the callback once when the manager is created and namespaces every sync channel with that value: manager presence, document, collection, list-query, and offline-session channels. During a mixed-version rollout, old and new tabs therefore use their own network requests and in-memory snapshots. This prevents both cross-version snapshot injection and cross-version `fetch-start` deduplication. `getAppVersion` only scopes browser-tab sync; use `persistentStorage.version` separately for persisted cache migrations.

Enable `createStoreManager({ debugLogger: true, ... })` to inspect transport open/close, publish, receive, skipped-message events, and leader changes in development. Store data sync uses store-specific channels, while tab-presence status uses one shared `presence` channel per manager/session. Presence prioritizes the focused tab; background tabs announce open/focus/blur changes and keep their last known fallback rank during quiet periods. Leader-change entries include the elected `leaderTabId`, whether the local tab is the leader, the local tab rank, and the ranked live-tab snapshot. Pass a logger function as `debugLogger` to route those entries to your own tooling.

## Required options

Add the following options to any store that should sync:

```ts
const storeManager = createStoreManager({
  getSessionKey: () => {
    return isLoggedIn ? `tenant:${tenantId}` : false;
  },
  getAppVersion: () => BUILD_VERSION,
  errorNormalizer: normalizeError,
  backgroundCoalescingDelayMs: 3_000,
});

const store = createDocumentStore({
  id: 'document-store',
  storeManager,
  /* ... */
});
```

The same keys are used by `createCollectionStore` and `createListQueryStore`.

See also: [Fetch Scheduling](./fetch-scheduling.md), where background tab focus ranking is integrated with coalescing.
