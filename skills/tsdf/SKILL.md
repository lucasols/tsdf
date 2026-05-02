---
name: tsdf
description: Reference for the `tsdf` React data fetching library. Use when code imports from `tsdf` or the user asks about TSDF stores, hooks, mutations, invalidation, persistent storage, or offline support.
---

# TSDF (TypeScript Data Fetching)

A typed React data fetching library built on `t-state`. It manages server data with three store types, scheduled fetches/caching, optimistic updates, granular invalidation, persistence, real-time updates, offline queueing, and cross-tab sync.

This skill is a concise map of the API. For anything not covered explicitly, read the shipped docs under `node_modules/tsdf/docs/` and the types entrypoint at `node_modules/tsdf/dist/main.d.ts` — both are part of the published package.

## Picking a store type

| Store             | Use case                                         | Key idea                                 |
| ----------------- | ------------------------------------------------ | ---------------------------------------- |
| `DocumentStore`   | One entity (current user, app settings)          | One fetch function, one slot of data     |
| `CollectionStore` | Items fetched independently by payload           | Each item has its own fetch lifecycle    |
| `ListQueryStore`  | Paginated lists + per-item fetches sharing state | Items deduped across queries; pagination |

Use `ListQueryStore` only when items must be shared between list views and detail views, or you need pagination, derived queries, optimistic list rules, partial resources, or offset pagination. Otherwise prefer `CollectionStore`.

Docs: `docs/document-store.md`, `docs/collection-store.md`, `docs/list-query-store.md`.

## Setup

Every store attaches to a single `storeManager`:

```ts
import { createStoreManager, createDocumentStore } from 'tsdf';

const storeManager = createStoreManager({
  getSessionKey: () => (auth.userId ? `tenant:${auth.tenantId}` : false),
  errorNormalizer: (err) => ({
    code: 500,
    id: 'fetch-error',
    message: err.message,
  }),
  offlineSession: undefined, // optional; required for offline queueing
});

const userStore = createDocumentStore<User>({
  id: 'document-user', // stable id; also used for browser tab sync
  storeManager,
  fetchFn: (signal) => api.getUser(signal),
  lowPriorityThrottleMs: 2000,
  baseCoalescingWindowMs: 100,
  blockWindowClose: null,
});
```

`getSessionKey` returning `false` disables persistence and tab sync until a session is ready. Stores with the same `id` and different session keys are isolated.

Docs: `docs/store-manager.md`, `docs/README.md` (full options matrix).

## Hooks

Every store ships React hooks with consistent behavior:

- Auto-fetch on mount; refetch on invalidation; deep equality to skip re-renders.
- Falsy payload (`null` / `undefined` / `false`) disables the hook — no fetch, status `idle`. Use this instead of a separate `enabled` flag.
- Common options: `disabled`, `disableRefetches`, `disableRefetchOnMount`, `returnIdleStatus`, `returnRefetchingStatus`, `ensureIsLoaded`, `selector`, `debouncePayload`.

| Store             | Hooks                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `DocumentStore`   | `useDocument`, `useListItem`, `useListItemIsLoading`, `useListItemIsDeleted`                                     |
| `CollectionStore` | `useItem`, `useMultipleItems`, `useListItem*`                                                                    |
| `ListQueryStore`  | `useListQuery`, `useMultipleListQueries`, `useItem`, `useMultipleItems`, `useFindItem`, `usePendingOfflineItems` |

Return shape: `{ data, status, error, isLoading, ... }`. `status` is `'idle' | 'loading' | 'success' | 'error' | 'refetching'` plus `'loadingMore'` (list queries) or `'deleted'` (items).

Docs: `docs/hooks.md` (every hook + options + return values).

## Fetch scheduling

Every fetch has a priority:

| Priority         | Source                             | Behavior                                                                                                          |
| ---------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `lowPriority`    | Hook mount, focus revalidation     | Throttled by `lowPriorityThrottleMs`                                                                              |
| `mediumPriority` | Background refetches               | Delayed by `mediumPriorityDelayMs`; cancelled if another fetch runs; promoted to `highPriority` when never loaded |
| `highPriority`   | User action, explicit invalidation | Runs immediately after the coalescing window; never throttled                                                     |
| `realtimeUpdate` | Push-driven updates                | Adaptive throttle via `dynamicRealtimeThrottleMs(...)`                                                            |

Requests within `baseCoalescingWindowMs` are merged into a single batch. Mutation locks defer fetches for affected items until the mutation finishes.

Batch fetching: `Collection` / `ListQuery` accept `batchFetchFn` + `getItemsBatchKey` + optional `maxBatchSize` to coalesce multiple item fetches into one request returning a `Map<payload, ItemState | Error>`.

Docs: `docs/fetch-scheduling.md`, `docs/batch-fetching.md`.

## Cache limits

`CollectionStore` and `ListQueryStore` bound in-memory state with LRU cache limits. Collection supports `maxItems` (default `5000`). List Query supports `maxItems` (default `5000`) and `maxQueries` (default `1000`).

Mounted hooks, in-flight fetches, and in-flight mutations are protected from eviction. List Query may evict whole inactive queries under item pressure to avoid leaving cached queries partially loaded. Use `onStateCleanup` to release app resources after cache-limit eviction.

Docs: `docs/cache-limits.md`.

## Mutations

`performMutation` is the primary mutation API:

```ts
const result = await store.performMutation(payload, {
  optimisticUpdate: (payload) => {
    store.updateItemState(payload, (draft) => {
      draft.name = newName;
    });
    // return false to cancel the mutation
  },
  mutation: (payload) => api.update(payload, { name: newName }),
  revalidateOnSuccess: true,
  // debounce?: { context, payload, ms }
  // onSuccess, onError, silentErrors, ...
});

if (result.ok) {
  /* result.value */
} else if (result.error.kind === 'skipped') {
  /* cancelled or superseded */
} else {
  /* StoreMutationError */
}
```

- Result is `Result<T, StoreMutationError | MutationSkipped>` (`t-result`).
- On error: optimistic updates roll back via automatic invalidation.
- `revalidateOnSuccess`: `true | false | 'queries' | (queryPayload) => boolean | { queries, items }` (List Query).
- Manual locks: `startMutation()` (Document), `startMutation(payload)` (Collection), `startItemMutation(itemId)` (List Query).
- `blockWindowClose` on `createStoreManager(...)` prevents accidental window close mid-mutation; it defaults to `null`.
- Lifecycle events: `store.storeEvents.on('mutationStart' | 'mutationEnd', ...)`.

Docs: `docs/mutations.md`.

## Invalidation

| Store             | API                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `DocumentStore`   | `invalidateData(priority?)`                                                                     |
| `CollectionStore` | `invalidateItem(payload \| payload[] \| filterFn, priority?)`                                   |
| `ListQueryStore`  | `invalidateQueryAndItems({ queryPayload, itemPayload, fields?, type? })`, `invalidateItem(...)` |

Same-or-higher pending invalidations swallow lower ones. Hooks with `disableRefetches` only refetch on `idle`/`error`; with `disableRefetchOnMount` only on explicit invalidation or first load. Window focus and transport reconnect can also auto-invalidate.

Docs: `docs/invalidation.md`.

## Persistent storage

Per-store `persistentStorage`:

```ts
persistentStorage: {
  adapter: 'local-sync',     // or opfsPersistentStorage / indexedDbPersistentStorage / createAsyncStorageAdapter(driver)
  schema: stateSchema,        // PersistentStorageSchema or ConvertedPersistentStorageDataSchema
  version: 1,                 // bump to invalidate older entries
  // Collection / ListQuery: payloadSchema, itemPayloadSchema, queryPayloadSchema, maxBytes/maxItemBytes/maxQueryBytes, maxQuerySize, pinnedItems, pinnedQueries, ignoreItems
  // optional: offline: { operations: { ... } }
  onPersistentStorageError: (err) => log(err),
}
```

The store reuses its `id` as the storage namespace and the manager's `getSessionKey` for session scoping. Async adapters (OPFS, IndexedDB, custom) require calling `preloadPersistentStorage()` / `preloadItemFromStorage(...)` / `preloadQueryFromStorage(...)` before reading. Prefer the built-in OPFS/IndexedDB adapters; use `createAsyncStorageAdapter(driver)` only when a custom `AsyncStorageDriver` backend is needed.

Use `ConvertedPersistentStorageDataSchema<TStore, TStorage>` when the in-memory store shape should differ from the persisted cache shape:

```ts
const schema: ConvertedPersistentStorageDataSchema<User, StoredUser> = {
  storeSchema: userSchema,
  storageSchema: storedUserSchema,
  convertToStorage: (user) => ({ n: user.name, s: user.score }),
  convertFromStorage: (stored) => ({ name: stored.n, score: stored.s }),
};
```

Loaded data must pass `storageSchema`, then `convertFromStorage(...)`, then `storeSchema`; fetched data runs through `convertToStorage(...)` before saving.

Utilities: `clearSessionStorage(sessionKey, adapter)`, `clearAllSessionStorage(sessionKey)`.

Docs: `docs/persistent-storage.md`.

## Offline

Offline support is layered on top of persistent storage and consists of:

1. Shared `offlineSession` on `createStoreManager(...)` (controls network awareness, mutation queueing policy, uploads).
2. Per-store `persistentStorage.offline.operations` — typed operation definitions used for queued mutations.

```ts
type UserOps = DefineListQueryOfflineOperations<
  User,
  UsersQuery,
  UserPayload,
  { renameUser: DefineOfflineOperation<{ id: number; name: string }> }
>;
```

Each operation declares `kind: 'create' | 'update' | 'delete'`, an `inputSchema`, `getEntityRefs`, `execute`, and optionally `onSuccessExecute`. Use the `offline` option on `performMutation(...)` to route a mutation through the queue (returns `OfflineMutationResult<T>` with `kind: 'online' | 'queued'`).

Reading state: `storeManager.useOfflineStatus()`, `useOfflineEntities()`, `useOfflineResolutions()`, `useOfflineUploads()`, plus per-store `useOfflineEntities()` / `useOfflineResolutions()` / `usePendingOfflineItems(...)` (List Query).

Conflict / retry: `parseOfflineResolutionConflict(...)`, `resolveOfflineResolution(id, operation, action)`.

Uploads: `saveOfflineUpload`, `replaceOfflineUpload`, `loadOfflineUpload`, `deleteOfflineUpload`, `resolveOfflineUpload(s)` (return `Result` objects). The shipped `opfsOfflineUploadAdapter` is one supported upload adapter.

Docs: `docs/offline.md`.

## Real-time updates

```ts
createDocumentStore({
  usesRealTimeUpdates: true,
  dynamicRealtimeThrottleMs: ({ lastFetchDuration, windowIsNotFocused }) =>
    windowIsNotFocused ? lastFetchDuration * 10 : lastFetchDuration * 2,
  // ...
});

socket.on('user-updated', (data) =>
  store.updateState((d) => Object.assign(d, data)),
);
store.onTransportReconnect(); // invalidate at realtimeUpdate priority after reconnect
```

`usesRealTimeUpdates: true` auto-disables `revalidateOnWindowFocus` and defaults hooks to `disableRefetchOnMount: true`.

Docs: `docs/real-time-updates.md`.

## List Query specific features

- **`optimisticListUpdates`** — auto add/remove/re-sort items in matching queries when item state changes (`filterItem`, `sort`, `appendNewTo`, `invalidateQueries`). Docs: `docs/optimistic-list-updates.md`.
- **Partial resources** (set `TPartialResources = true`) — fetch only specific fields per item; tracks loaded fields and supports per-field invalidation. `fetchListFn` / `fetchItemFn` receive `{ fields }`. Docs: `docs/partial-resources.md`.
- **Offset pagination** (set `TOffsetPagination = true`) — real offset/limit pagination instead of size-mode re-fetches. `fetchListFn` receives `{ offset, limit }`; `offsetPagination: { maxInvalidationLimit, maxParallel }`. Docs: `docs/offset-pagination.md`.
- **`derivedQueries`** — hook results computed locally from already-materialized items when `isComplete(...)` returns `true`; results expose `isDerived: true` and `hasMore: false`, and never materialize a query entry.
- **`addItemToState(payload, data, { addItemToQueries: { queries, appendTo } })`** — insert a new item into specific queries with `'start' | 'end' | (payloads) => index` placement.

## Browser tab sync

Automatic when all tabs share the same store `id` and the same `getSessionKey()`. Tabs deduplicate `fetch-start`/`fetch-success` activity and apply confirmed snapshots in version order over `BroadcastChannel`. Background tabs get an extended coalescing window so duplicate background work is dropped.

Docs: `docs/browser-tabs-sync.md`.

## Shared types and utilities

Exported from `tsdf` (see `docs/shared-types.md`):

- `StoreError` — normalized error shape produced by `errorNormalizer`.
- `StoreFetchError` — thrown by `awaitFetch*` (types: `'fetch' | 'timeout' | 'aborted'`).
- `StoreMutationError` — `performMutation` failure with `cause` and normalized fields.
- `MutationSkipped` / `mutationSkipped` — sentinel for cancelled/superseded mutations.
- `fetchTypePriority` — priority constants used by the scheduler.
- `IsOffScreenContext` — React context that propagates `isOffScreen` to nested hooks.
- `PayloadDebounce` — option type for hook `debouncePayload`.

Persistent storage / offline types are re-exported (e.g. `PersistentStorageSchema`, `PersistentStorageDataSchema`, `ConvertedPersistentStorageDataSchema`, `StorageAdapter`, `AsyncStorageAdapter`, `AsyncStorageDriver`, `DocumentPersistentStorageConfig`, `CollectionPersistentStorageConfig`, `ListQueryPersistentStorageConfig`, `DefineDocumentOfflineOperations`, `DefineCollectionOfflineOperations`, `DefineListQueryOfflineOperations`, `OfflineMutationResult`, `OfflineRuntimeConfig`, etc.) — read `node_modules/tsdf/dist/main.d.ts` for the authoritative list.

## Conventions when writing code with TSDF

- One `storeManager` per app/session domain; many stores attached to it. Stores can be created at module scope.
- Always set a stable `id` per store (it scopes persistence and powers tab sync).
- Use the typed payload overloads (`payload | payload[] | (data, payload) => boolean`) for `invalidateItem`, `getItemState`, `updateItemState`, `deleteItemState`, `startMutation`, `scheduleFetch` — don't loop in user code.
- Disable hooks via falsy payload, not a separate `enabled` flag.
- Update local state through `updateState` / `updateItemState` (immer drafts) so optimistic list updates and tab sync fire correctly.
- For offline-aware mutations, prefer `performMutation` with the `offline` option over manual queue handling.
- Read `node_modules/tsdf/dist/main.d.ts` directly for exact option/return shapes — types encode required vs optional and payload overloads more precisely than any prose.

## Where to read more

Shipped under `node_modules/tsdf/docs/`:

- `README.md` — overview + full common-options matrix
- `document-store.md`, `collection-store.md`, `list-query-store.md` — per-store API
- `store-manager.md` — manager, registry, offline session, uploads
- `hooks.md` — every hook with options/return values
- `fetch-scheduling.md`, `invalidation.md`, `mutations.md` — runtime behavior
- `persistent-storage.md`, `offline.md`, `cache-limits.md`, `real-time-updates.md`
- `optimistic-list-updates.md`, `partial-resources.md`, `offset-pagination.md`, `batch-fetching.md`, `browser-tabs-sync.md`
- `shared-types.md` — error and utility types

Types: `node_modules/tsdf/dist/main.d.ts` (entry point declared in `package.json#types`).
