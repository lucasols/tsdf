---
name: tsdf
description: Reference for the `tsdf` React data fetching library. Use when code imports from `tsdf` or the user asks about TSDF stores, hooks, mutations, invalidation, persistent storage, or offline support.
---

# TSDF (TypeScript Data Fetching)

A typed React data fetching library built on `t-state`. It manages server data with three store types, scheduled fetches/caching, optimistic updates, granular invalidation, persistence, real-time updates, offline queueing, and cross-tab sync.

This skill is a concise map of the API. For anything not covered explicitly, read the shipped docs under `node_modules/tsdf/docs/` and the types entrypoint at `node_modules/tsdf/dist/main.d.ts` — both are part of the published package. Doc references like `docs/offline.md#health-check` are relative to the package root and name a heading of that file.

## Picking a store type

| Store             | Use case                                         | Key idea                                 |
| ----------------- | ------------------------------------------------ | ---------------------------------------- |
| `DocumentStore`   | One entity (current user, app settings)          | One fetch function, one slot of data     |
| `CollectionStore` | Items fetched independently by payload           | Each item has its own fetch lifecycle    |
| `ListQueryStore`  | Paginated lists + per-item fetches sharing state | Items deduped across queries; pagination |

Use `ListQueryStore` only when items must be shared between list views and detail views, or you need pagination, derived queries, optimistic list rules, partial resources, or offset pagination. Otherwise prefer `CollectionStore`.

Check more on docs: `docs/document-store.md`, `docs/collection-store.md`, `docs/list-query-store.md`.

## Setup

Every store attaches to a single `storeManager`:

```ts
import { createStoreManager, createDocumentStore } from 'tsdf';

const storeManager = createStoreManager({
  getSessionKey: () => (auth.userId ? `tenant:${auth.tenantId}` : false),
  getAppVersion: () => BUILD_VERSION, // optional; isolates tab sync across deployments
  errorNormalizer: (err) => ({
    code: 500,
    id: 'fetch-error',
    message: err.message,
  }),
  lowPriorityThrottleMs: 40 * 60 * 1_000, // optional; defaults to 40 minutes
  baseCoalescingWindowMs: 16, // optional; defaults to 16ms
  blockWindowClose: null, // optional manager-wide mutation close blocker
  revalidateOnWindowFocus: true, // optional default for attached stores
  onMutationError: (err) => log(err), // optional global mutation fallback
  onPersistentStorageError: (err) => log(err), // optional global persistence fallback
  debugLogger: false, // true/function: verbose dev-only tab sync + persistence logs
  logger: true, // optional; true/function/false for low-volume production-safe logs
  offlineSession: undefined, // optional; required for offline queueing
});

const userStore = createDocumentStore<User>({
  id: 'document-user', // stable id; also used for browser tab sync
  storeManager,
  fetchFn: (signal) => api.getUser(signal),
  lowPriorityThrottleMs: 2000, // optional store override
  baseCoalescingWindowMs: 100, // optional store override
  revalidateOnWindowFocus: false, // disables inherited manager default
  onMutationError: null, // disables inherited manager fallback
});
```

`getSessionKey` returning `false` disables persistence and tab sync until a session is ready. Stores with the same `id` and different session keys are isolated. Deployed apps should provide a stable `getAppVersion` build identifier so tabs running different bundles cannot exchange fetch activity or snapshots; this is separate from per-store `persistentStorage.version`.

Check more on docs: `docs/store-manager.md`, `docs/README.md` (full options matrix).

## Hooks

Every store ships React hooks with consistent behavior:

- Auto-fetch on mount; refetch on invalidation; deep equality to skip re-renders.
- Falsy payload (`null` / `undefined` / `false`) disables the hook — no fetch, status `idle`. Use this instead of a separate `enabled` flag.
- Common options: `disabled`, `disableRefetches`, `disableRefetchOnMount`, `returnIdleStatus`, `returnRefetchingStatus`, `requireFreshData`, `selector`, `debouncePayload`.
- Use `requireFreshData: true` sparingly: every enabled mount schedules a high-priority fetch even with cached data and reports `loading` until it settles, so broad use multiplies requests. Prefer normal cache behavior or targeted invalidation. `requireFreshData: 'ifFromStorage'` does it only while the data was restored from persistent storage and not refreshed from the server yet in this tab. See `docs/hooks.md#requirefreshdata`.

| Store             | Hooks                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `DocumentStore`   | `useDocument`, `useListItem`, `useListItemIsLoading`, `useListItemIsDeleted`                                                            |
| `CollectionStore` | `useItem`, `useMultipleItems`, `useListItem*`, `useItemOfflineState`                                                                    |
| `ListQueryStore`  | `useListQuery`, `useMultipleListQueries`, `useItem`, `useMultipleItems`, `useFindItem`, `usePendingOfflineItems`, `useItemOfflineState` |

Return shape: `{ data, status, error, isLoading, ... }`. `status` is `'idle' | 'loading' | 'success' | 'error' | 'refetching'` plus `'loadingMore'` (list queries) or `'deleted'` (items).

Check more on docs: `docs/hooks.md` (every hook + options + return values).

## Fetch scheduling

Every fetch has a priority:

| Priority         | Source                                                 | Behavior                                                                                                          |
| ---------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `lowPriority`    | Hook mount, focus revalidation                         | Throttled by `lowPriorityThrottleMs`                                                                              |
| `mediumPriority` | Background refetches                                   | Delayed by `mediumPriorityDelayMs`; cancelled if another fetch runs; promoted to `highPriority` when never loaded |
| `highPriority`   | User action, explicit invalidation, `requireFreshData` | Runs immediately after the coalescing window; never throttled                                                     |
| `realtimeUpdate` | Push-driven updates                                    | Adaptive throttle via `dynamicRealtimeThrottleMs(...)`                                                            |

Requests within `baseCoalescingWindowMs` are merged into a single scheduler flush. Mutation locks defer fetches for affected items until the mutation finishes.

Imperative cache-or-fetch reads return `t-result` values with `StoreFetchError` errors: Document `getDataFromStateOrFetch`, Collection `getItemFromStateOrFetch`, List Query `getQueryFromStateOrFetch` / `getItemFromStateOrFetch`. They return loaded state by default, fetch if missing, and accept `ignoreStaleState` to fetch when cached state has `refetchOnMount`.

Check more on docs: `docs/fetch-scheduling.md`, `docs/batch-fetching.md`.

## Optimization features

- **Batch item fetching** — coalesce multiple item fetches in the same scheduler window into one network request returning `Map<payload, ItemState | Error>`.
- **Collection batch fetch** — `batchFetchFn(payloads, signal, batchKey)` plus optional `getItemsBatchKey(payload)` and `maxBatchSize`.
- **List Query batch item fetch** — `batchFetchItemFn(requests, { signal, batchKey })` plus optional `getItemsBatchKey(payload)` and `maxItemBatchSize` (defaults to 50). Each request is `{ payload, fields? }`, so batch item fetching works with partial resources.
- **Batch groups** — `getItemsBatchKey` groups items into separate batch schedulers; return `false` to opt out for that item and use the per-item fetch function.
- **Bulk hooks** — `useMultipleItems` and `useMultipleListQueries` let callers subscribe to many resources through one hook while sharing the same scheduler/cache machinery.
- **Selectors + deep equality** — hook `selector` options reduce re-renders by returning only the data the component needs.

Check more on docs: `docs/batch-fetching.md`, `docs/hooks.md`.

## Cache limits

`CollectionStore` and `ListQueryStore` bound in-memory state with LRU cache limits. Collection supports `maxItems` (default `5000`). List Query supports `maxItems` (default `5000`) and `maxQueries` (default `1000`).

Mounted hooks, in-flight fetches, and in-flight mutations are protected from eviction. List Query may evict whole inactive queries under item pressure to avoid leaving cached queries partially loaded. Use `onStateCleanup` to release app resources after cache-limit eviction.

Check more on docs: `docs/cache-limits.md`.

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
- On error: the optimistic update is reverted; data changed again while in flight (e.g. by a concurrent mutation) is kept and revalidated instead. Debounced calls roll back to the state before the first superseded call.
- `store.cancelDebouncedMutation({ context, payload })` cancels a pending debounced call and reverts its optimistic updates.
- `silentErrors: true` still calls `onMutationError(error, { silentErrors: true })`; handlers should use the flag to suppress user-facing noise while preserving logging/recovery.
- `revalidateOnSuccess`: `true | false | 'queries' | (queryPayload) => boolean | { queries, items }` (List Query).
- Manual locks: `startMutation()` (Document), `startMutation(payload)` (Collection), `startItemMutation(itemId)` (List Query).
- `blockWindowClose` on `createStoreManager(...)` prevents accidental window close mid-mutation; it defaults to `null`.
- Lifecycle events: `store.storeEvents.on('mutationStart' | 'mutationEnd', ...)`.
- Items created offline: `store.storeEvents.on('tempEntityReconciled', ({ payload: { tempId, finalPayload } }) => ...)` fires in every tab when the item is saved; `store.resolveTempItemPayload(payload)` returns the final payload later (Collection, List Query).

Check more on docs: `docs/mutations.md`.

## Invalidation

| Store             | API                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `DocumentStore`   | `invalidateData(priority?)`                                                                                                      |
| `CollectionStore` | `invalidateItem(payload \| payload[] \| filterFn, priority?)`                                                                    |
| `ListQueryStore`  | `invalidateQueryAndItems({ all: true, fields?, type? } \| { queryPayload, itemPayload, fields?, type? })`, `invalidateItem(...)` |

Same-or-higher pending invalidations swallow lower ones. Hooks with `disableRefetches` only refetch on `idle`/`error`; with `disableRefetchOnMount` only on explicit invalidation or first load. Window focus and transport reconnect can also auto-invalidate.

Utilities: use `GET_ALL` as the all-payload predicate and `{ all: true }` to invalidate every List Query query and item.

Check more on docs: `docs/invalidation.md`.

## Persistent storage

Per-store `persistentStorage`:

```ts
persistentStorage: {
  adapter: 'local-sync',     // or async adapters from 'tsdf/opfs-storage' / 'tsdf/indexed-db-storage'
  schema: stateSchema,        // PersistentStorageSchema or ConvertedPersistentStorageDataSchema
  version: 1,                 // bump to invalidate older entries
  enabled: () => !isPublicSession, // optional runtime switch: false skips all reads/writes of this store
  // Collection / ListQuery: payloadSchema, itemPayloadSchema, queryPayloadSchema, maxBytes/maxItemBytes/maxQueryBytes, maxQuerySize, pinnedItems, pinnedQueries, ignoreItems
  // optional: offline: { operations: { ... } }
  onPersistentStorageError: (err) => log(err), // overrides the manager fallback; use null to disable it
}
```

The store reuses its `id` as the storage namespace and the manager's `getSessionKey` for session scoping. Async adapters require calling `preloadPersistentStorage()` / `preloadItemFromStorage(...)` / `preloadQueryFromStorage(...)` before reading. Import OPFS from `tsdf/opfs-storage`, IndexedDB from `tsdf/indexed-db-storage`, and use `createAsyncStorageAdapter(driver)` from `tsdf/async-storage` only when a custom `AsyncStorageDriver` backend is needed.

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

Changing a store's `adapter` starts it with an empty cache and migrates nothing, including queued offline work: let the queue drain first. See `docs/persistent-storage.md#changing-a-stores-adapter`.

Deleting a store leaves its data behind: list it in `createStoreManager({ removedStores: [{ id, adapter }] })` so TSDF removes it. See `docs/persistent-storage.md#deleting-a-store`.

Utilities: `clearSessionStorage(sessionKey, adapter)`, `clearAllSessionStorage(sessionKey)`.

Check more on docs: `docs/persistent-storage.md`.

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

Each operation declares `kind: 'create' | 'update' | 'delete'`, an `inputSchema`, `getEntityRefs`, `execute`, and optionally `onSuccessExecute`. Use the `offline` option on `performMutation(...)` to route a mutation through the queue (returns `OfflineMutationResult<T>` with `kind: 'online' | 'queued'`; `offline: descriptor | undefined` is accepted and returns `T | OfflineMutationResult<T>`). Optional per-operation behavior: `dependsOn`, `cancelledWith` (entities of other stores this work follows), `supersedes`, `accumulation` (`mergeInput`, optional `canMerge` to keep an edit apart), `conflictHandling`, `shouldSkipSync`, `getServerSnapshot`, `dependsOnUploads`; see `docs/offline.md#operation-definitions`.

Offline creates: `tempEntity` / `tempEntities` (Collection and List Query) insert a pending entity under a temp payload and reconcile it to the server payload after replay. In List Query stores, `addToQueries` puts the pending entity in the lists that should show it (no manual `addItemToState`), and `loadedFields` declares its loaded fields when partial resources are enabled.

Reading state: `storeManager.useOfflineStatus()`, `useOfflineEntities()`, `useOfflineResolutions()`, `useOfflineUploads()`, plus per-store `useOfflineEntities()` / `useOfflineResolutions()` / `usePendingOfflineItems(...)` (List Query; its `selector` also gets each item's `ItemOfflineState`). For per-row sync badges use `useItemOfflineState(payload)` / `getItemOfflineState(payload)` (Collection, List Query): `null` or `{ syncState, pendingMutations, requiresResolution, isUnsentCreation, creationAttempted }`, re-rendering only when that item's state changes.

Deleting something created offline: give the delete operation `supersedes: { scope: 'same-entity', dropSelfIfTempLifecycleCancelled: true }` and treat not-found as success in its `execute`. A creation never sent (`isUnsentCreation && !creationAttempted`) is cancelled locally with the work queued on it; an attempted one is kept and the delete replays after it. See `docs/offline.md#deleting-entities-created-offline`.

Reads while offline: cached data stays `status: 'success'` with `error: null`; only reads with nothing cached fail, with the offline error — detect it with `isOfflineStoreError(error)` instead of comparing `error.id`.

Conflict / retry: per-store `parseOfflineResolutionConflict(...)`, `resolveOfflineResolution(id, operation, action)`. For session-wide UI, `storeManager.resolveOfflineResolution(id, 'retry' | 'discard')` finds the owning store and returns a `Result` (`error.code` explains why it was not applied). See `docs/offline.md#conflict-resolution`.

Recovery: each attached store revalidates by itself once the session is back online and its queued mutations replayed — no manual invalidation needed on reconnect. See `docs/offline.md#revalidation-after-recovering`.

Health check: `offlineSession.healthCheck: { check: ({ sessionKey, signal }) => 'up' | 'outage' | 'unreachable', timeoutMs?, reuseUpForFailuresMs? }` both classifies failed requests and checks recovery (making `outage.recoveryCheck` optional): `'unreachable'` enters network mode, `'outage'` enters outage mode, and `'up'` keeps the session online (or ends offline mode), leaving a failed request to its own error handling. Session `classifyFailure` / `classifyRetryableFailure` hooks refine per-error classification. `await storeManager.reportOfflineFailure(error)` classifies the failure of a request the app sends itself (e.g. an upload) and resolves to `'network' | 'outage' | 'ignore'` (`docs/offline.md#failures-of-the-apps-own-requests`). See `docs/offline.md#health-check`.

Session gate: `offlineSession.enabled: () => boolean | 'replay-only'` turns the whole offline layer on/off at runtime (feature flag, per-workspace setting). While it returns `false` — or `getSessionKey()` returns `false` — the session never enters offline mode and mutations with an `offline` descriptor run as plain online mutations (`{ kind: 'online', data }`, normal errors); `status.isNetworkDetectedOffline` still reports the detected connectivity (`docs/offline.md#connection-state`). Already-queued work is kept and replayed after the gate reopens. Return `'replay-only'` to keep replaying queued work while no new work is queued (e.g. a workspace losing offline mode). See `docs/offline.md#session-gate`.

Uploads: configure `offlineSession.uploads` (`adapter`, e.g. the shipped `opfsOfflineUploadAdapter`, and an `upload` transport). Manager helpers: `saveOfflineUpload({ id, file, metadata? })`, `replaceOfflineUpload`, `loadOfflineUpload`, `deleteOfflineUpload`, `resolveOfflineUpload(s)` (return `Result` objects), `useOfflineUploads()`, and `useOfflineUploadFile(id)` to render a staged file (`resolvedRef` on `missing` once it was sent and deleted). Operations declare their files with `dependsOnUploads({ input })` and read refs from `execute({ uploads })`; a `performMutation` with `offline` that runs online gets the same `uploads` in its `mutation` context (see `docs/offline.md#direct-runs`). A staged upload is deleted automatically once the last queued mutation or resolution that declares it leaves the queue, or once a mutation that declares it ran directly; uploads no mutation used stay until `deleteOfflineUpload` or expiry. Details: `docs/offline.md#upload-refs` (typing with `StoreManagerUploadRef`, `resolvedRefSchema`), `docs/offline.md#upload-metadata`, `docs/offline.md#rendering-staged-files`, `docs/offline.md#upload-failure-handling`.

Multiple tabs of a session share one queue: only the leading (visible) tab replays, including mutations queued in other tabs, and each queued mutation is sent once. Create a session's stores in every tab so the leading tab can replay them. See `docs/offline.md#multiple-tabs`.

Testing: `await storeManager.setForcedOfflineMode(true | false)` forces the session offline without cutting the connection (survives reloads, shared across tabs, reported as `getOfflineStatus().isForcedOffline`; requires `offlineSession.network`). `createOfflineNetworkMock()` from `tsdf/testing` mocks the network status in unit tests. See `docs/offline.md#forced-offline-mode`, `docs/offline.md#testing`.

Check more on docs: `docs/offline.md`.

## Real-time updates

```ts
createDocumentStore({
  usesRealTimeUpdates: true,
  dynamicRealtimeThrottleMs: ({ lastFetchDuration, windowIsNotFocused }) =>
    windowIsNotFocused ? lastFetchDuration * 10 : lastFetchDuration * 2,
  // ...
});

// Or configure dynamicRealtimeThrottleMs once on createStoreManager(...);
// store-level callbacks override the manager default. The built-in manager
// default is 100ms focused and 1000ms in the background.

socket.on('user-updated', (data) =>
  store.updateState((d) => Object.assign(d, data)),
);
storeManager.onTransportReconnect(); // notify attached realtime stores after reconnect
```

`usesRealTimeUpdates: true` auto-disables `revalidateOnWindowFocus` and defaults hooks to `disableRefetchOnMount: true`.

Check more on docs: `docs/real-time-updates.md`.

## List Query specific features

- **`optimisticListUpdates`** — auto add/remove/re-sort items in matching queries when item state changes (`filterItem`, `sort`, `appendNewTo`). Check more on docs: `docs/optimistic-list-updates.md`.
- **Partial resources** (set `TPartialResources = true`) — fetch only specific fields per item; tracks loaded fields and supports per-field invalidation. `partialResources` requires `mergeItems`, `selectFields`, and `inferFields`. `fetchListFn` / `fetchItemFn` receive `{ fields }`. Check more on docs: `docs/partial-resources.md`.
- **Offset pagination** (set `TOffsetPagination = true`) — real offset/limit pagination instead of size-mode re-fetches. `fetchListFn` receives `{ offset, limit }`; `offsetPagination: { maxInvalidationLimit, maxParallel }`. Check more on docs: `docs/offset-pagination.md`.
- **`derivedQueries`** — hook results computed locally from already-materialized items when `isComplete(...)` returns `true`; results expose `isDerived: true` and `hasMore: false`, and never materialize a query entry.
- **`addItemToState(payload, data, { addItemToQueries: { queries, appendTo } })`** — insert a new item into specific queries with `'start' | 'end' | (payloads) => index` placement.

## Browser tab sync

Automatic when all tabs share the same store `id`, `getSessionKey()`, and (when configured) `getAppVersion()`. Tabs deduplicate `fetch-start`/`fetch-success` activity and apply confirmed snapshots in version order over `BroadcastChannel`. Background tabs get an extended coalescing window so duplicate background work is dropped. Use a build-specific `getAppVersion` in deployed apps to isolate incompatible bundles.

Check more on docs: `docs/browser-tabs-sync.md`.

## Shared types and utilities

Exported from `tsdf` (see `docs/shared-types.md`):

- `StoreError` — normalized error shape produced by `errorNormalizer`.
- `StoreFetchError` — returned by `awaitFetch*` and cache-or-fetch helpers (types: `'fetch' | 'timeout' | 'aborted'`).
- `StoreMutationError` — `performMutation` failure with `cause` and normalized fields.
- `StoreMutationErrorOptions` — options passed to `onMutationError`, including `silentErrors`.
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
