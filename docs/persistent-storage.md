# Persistent Storage

TSDF can persist cached data across page reloads and browser sessions through the optional `persistentStorage` option on each store type.

See also: [Document Store](./document-store.md) | [Collection Store](./collection-store.md) | [List Query Store](./list-query-store.md) | [Offline](./offline.md)

## What it does

- Loads cached entries before network fetches when available.
- Persists successful fetch results back to local storage.
- Invalidates and drops cache entries when schema or version checks fail.
- Uses session scoped keys, so data is isolated per tenant/account.

## Public API

Exported from `tsdf`:

| Export                                                                                                       | Description                                                      |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `PersistentStorageSchema`                                                                                    | Schema type supported by cache validation                        |
| `PersistentStorageDataSchema` / `ConvertedPersistentStorageDataSchema`                                       | Direct or converted persisted data schema config                 |
| `StorageAdapter`                                                                                             | `'local-sync'` or a managed async storage adapter                |
| `DocumentPersistentStorageConfig` / `CollectionPersistentStorageConfig` / `ListQueryPersistentStorageConfig` | Store-level persistence config types                             |
| `createStoreManager(options)`                                                                                | Creates the shared store manager used by all stores              |
| `RemovedStore`                                                                                               | A deleted store listed in the manager's `removedStores`          |
| `PersistentStoragePreloadResult<Payload>`                                                                    | Return shape for preload methods                                 |
| `localPersistentStorage`                                                                                     | Built-in localStorage helper used by the `'local-sync'` adapter  |
| `clearSessionStorage(sessionKey, adapter)`                                                                   | Clears all TSDF entries for one session/adapter                  |
| `clearAllSessionStorage(sessionKey)`                                                                         | Clears all TSDF entries for one session across built-in adapters |

Exported from async-storage subpaths:

| Export                                       | Import From               | Description                                                   |
| -------------------------------------------- | ------------------------- | ------------------------------------------------------------- |
| `opfsPersistentStorage`                      | `tsdf/opfs-storage`       | Built-in OPFS async storage adapter                           |
| `indexedDbPersistentStorage`                 | `tsdf/indexed-db-storage` | Built-in IndexedDB async storage adapter                      |
| `createIndexedDbPersistentStorage(options?)` | `tsdf/indexed-db-storage` | Creates an IndexedDB adapter, optionally with a database name |
| `createAsyncStorageAdapter(driver)`          | `tsdf/async-storage`      | Wraps a custom async storage driver                           |

## Configuration

Each store accepts `persistentStorage` in options:

| Store            | Config Type                                                              |
| ---------------- | ------------------------------------------------------------------------ |
| Document Store   | `DocumentPersistentStorageConfig<State>`                                 |
| Collection Store | `CollectionPersistentStorageConfig<ItemState, ItemPayload>`              |
| List Query Store | `ListQueryPersistentStorageConfig<ItemState, QueryPayload, ItemPayload>` |

Common options (applies to all store configs):

| Option                            | Required | Description                                                                                                                      |
| --------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                          | Yes      | Schema used to validate restored data.                                                                                           |
| `adapter`                         | Yes      | `'local-sync'`, `opfsPersistentStorage`, `indexedDbPersistentStorage`, or a custom async adapter.                                |
| `version`                         | No       | Cache version; bump to invalidate old entries.                                                                                   |
| `onPersistentStorageError(error)` | No       | Store-specific callback for write/read failures (quota, decode, etc.). Overrides the manager fallback; use `null` to disable it. |

Store-specific options:

| Store            | Additional options                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Collection Store | `payloadSchema`, `maxBytes`, `pinnedItems`, `ignoreItems`                                                                                 |
| List Query Store | `itemPayloadSchema`, `queryPayloadSchema`, `maxItemBytes`, `maxQueryBytes`, `maxQuerySize`, `pinnedItems`, `pinnedQueries`, `ignoreItems` |

> With [Partial Resources](./partial-resources.md), items are saved with only the fields loaded so far, and each restored item is validated against `schema`. Make the fields that hooks may leave out optional in the schema: an item saved without a required field is discarded when it is read back, so it is not available as cached data.

> `persistentStorage` automatically reuses the store's existing `id` for its storage namespace and the store manager's `getSessionKey` for session scoping. When `getSessionKey` returns `false`, no persistence operations run.

Enable `createStoreManager({ debugLogger: true, ... })` to inspect load, save/write, commit, clear, metadata, and offline protection persistence operations in development. Production-safe quota cleanup logs are emitted through the manager `logger` by default; they include the affected quota, configured byte budget, total unprotected bytes, and kept/evicted entry counts. Pass `logger: false` to disable them. Async adapters also emit timed `adapter-operation` entries with `durationMs` for concrete OPFS, IndexedDB, or custom driver work in development.

## Converted Data Schemas

Use `ConvertedPersistentStorageDataSchema<TStore, TStorage>` when the in-memory store shape should differ from the data saved in persistent storage. This is useful for compact cache formats, migration-friendly storage shapes, or persisted data that should omit derived fields.

```ts
import { rc_number, rc_object, rc_string } from 'runcheck';
import type { ConvertedPersistentStorageDataSchema } from 'tsdf';

type User = { profile: { name: string; score: number } };

type StoredUser = { n: string; s: number };

const userPersistenceSchema: ConvertedPersistentStorageDataSchema<
  User,
  StoredUser
> = {
  storeSchema: rc_object({
    profile: rc_object({ name: rc_string(), score: rc_number() }),
  }),
  storageSchema: rc_object({ n: rc_string(), s: rc_number() }),
  convertToStorage: (user) => ({ n: user.profile.name, s: user.profile.score }),
  convertFromStorage: (stored) => ({
    profile: { name: stored.n, score: stored.s },
  }),
};

const userStore = createDocumentStore<User>({
  id: 'document-user',
  storeManager,
  fetchFn: (signal) => api.getUser(signal),
  lowPriorityThrottleMs: 2000,
  baseCoalescingWindowMs: 100,
  blockWindowClose: null,
  persistentStorage: { adapter: 'local-sync', schema: userPersistenceSchema },
});
```

Validation runs on both sides of the conversion:

- Loaded cache data must pass `storageSchema`.
- `convertFromStorage(...)` maps it to the store shape.
- The converted result must pass `storeSchema`.
- Successful fetch data passes through `convertToStorage(...)` before being saved.

If `convertFromStorage(...)`, `convertToStorage(...)`, or either schema fails, TSDF reports the error through `onPersistentStorageError` when available and removes or skips the invalid cache entry.

If `persistentStorage.offline` is configured, pass one shared offline session config to `createStoreManager(...)` and keep store-local offline behavior in `persistentStorage.offline.operations`. `createStoreManager(...)` owns that session internally and expects config, not an existing `OfflineSession` object.

Each offline operation now requires a `kind`:

- `create` for temp-entity or create-style mutations
- `update` for in-place edits
- `delete` for destructive mutations

TSDF reduces those operation kinds into a derived `GlobalOfflineEntity.kind`
value (`create`, `createAndUpdate`, `update`, or `delete`) so queue-aware UI
can read one stable lifecycle field instead of inferring it from store
snapshots.

Session-level `mutationQueueing` can allow or disallow durable offline mutation queueing separately for `network` and `outage` causes. This only affects mutations using the `offline` option and does not change offline reads.

## Adapter behavior

TSDF does not choose a persistence adapter automatically. Pass one of the built-in adapters or a custom async adapter in every `persistentStorage` config.

Scheduled collection and list-query maintenance is deadline-aware for every adapter. TSDF slices its own metadata validation, filtering, and byte-budget ordering across idle callbacks, carrying its progress from one callback to the next. Async adapters additionally commit removals in bounded batches, with each batch using a self-contained driver transaction or write; TSDF never keeps an IndexedDB, OPFS, or custom-driver transaction open while waiting for another idle deadline. Each batch is a conditional remove: the adapter checks every entry's access time, size, version, and offline protection against what the run planned from, in the same write that removes it, and keeps entries that changed meanwhile. TSDF then schedules another maintenance pass that plans from fresh metadata. Adapters created with `createAsyncStorageAdapter` (including the built-in OPFS and IndexedDB adapters) perform this check atomically; for other custom adapters TSDF re-reads metadata right before removing, so a write landing in between is not detected.

### `local-sync`

- Uses managed `localStorage` entries.
- Can hydrate synchronously during initial state creation for `DocumentStore`.
- `CollectionStore` and `ListQueryStore` use lazy hydration for unknown entries from initial keys scan.
- Writes are debounced and may be dropped if serialization errors occur.
- Scheduled expiration and byte-budget maintenance is split across browser idle deadlines. Timeout-fired callbacks and browsers without `requestIdleCallback` use short timer-backed slices, so large scans and eviction batches yield between slices while keeping payload entries and manifests consistent.
- When a write hits the browser `QuotaExceededError` (the shared origin quota is full, e.g. because other parts of the app filled `localStorage`), TSDF automatically evicts its own least recently used entries — across all TSDF stores and sessions — and retries, escalating to all non-offline-protected entries if needed. Offline data and non-TSDF keys are never touched. If even that cannot free enough space, a single descriptive error is reported through `onPersistentStorageError` and persistence writes are silently skipped until the next page load. Removals of persisted entries (e.g. after deleting an item) still go through while writes are disabled, so deleted data never resurrects on the next load.

Use it with:

```ts
persistentStorage: {
  adapter: 'local-sync',
  schema: settingsSchema,
}
```

### `opfsPersistentStorage`

- Uses `FileSystemAccess`-backed persistent storage.
- Hydration is asynchronous, and can be triggered explicitly with preload APIs.

### `indexedDbPersistentStorage`

- Alternative built-in async adapter for browsers where IndexedDB is preferred.
- Stores one logical row per entry and uses native indexes for recency ordering, group lookups, and protected-key scans.
- Hydration is asynchronous, and can be triggered explicitly with preload APIs.

Use `createIndexedDbPersistentStorage({ databaseName })` from `tsdf/indexed-db-storage` when an app needs an isolated IndexedDB database.

#### Connection recovery

Browsers can take an IndexedDB connection away from a page that keeps running: the storage process restarts, a backgrounded mobile tab comes back with a dead connection, or another tab upgrades or deletes the database. The adapter recovers without a page reload:

- A failed open is not remembered. The next operation opens the database again.
- When the browser closes the connection (`close`), or another tab needs it released (`versionchange`), the adapter closes and forgets it, so the other tab is not blocked. The next operation opens a new connection.
- When an operation fails with a connection error (`InvalidStateError`, `AbortError`, or `UnknownError`, e.g. WebKit's "Connection to Indexed Database server lost"), the adapter drops the connection, opens a new one, and runs the operation once more. Every adapter operation is a self-contained transaction that writes whole values, so repeating it never applies a batch twice or leaves half of it behind. Quota, data, and version errors are not retried.
- When IndexedDB stops answering — an open or a transaction delivers no event at all — the operation is treated like a lost connection after two consecutive checks, 15 seconds apart, during which no event of the same database reached the page while the tab was visible (30 to 45 seconds). Progress is what is measured, not total duration: a large batch on a slow device is never cut short in the tab running it. Only events reaching this page count, so an operation of another tab that waits more than 30 seconds behind that batch can still be given up and retried. A check interval during which the tab was hidden at any point, or the page was not running at all (frozen tab, sleeping device), does not count, so an operation is never given up the moment a page resumes.

If the second attempt also fails, the error is reported through `onPersistentStorageError`. Recovery depends on the browser accepting a new connection; some Safari versions refuse one until the page is reloaded, in which case each failing operation is reported instead of staying pending.

#### When a write fails

A persistence write that still fails after the recovery above is reported through `onPersistentStorageError` and dropped. In-memory store state is not affected and the app keeps working; the entry keeps its previous persisted value (or stays absent) until the store saves it again. See [Offline](./offline.md#queuing-mutations) for what this means for queued mutations.

### Custom async adapters

Use `createAsyncStorageAdapter(driver)` only when the built-in OPFS and IndexedDB adapters are not a fit. It wraps an `AsyncStorageDriver`, which is the low-level async backend contract used by TSDF persistence internals.

A driver is responsible for storing raw records by logical namespace:

```ts
import type { AsyncStorageDriver } from 'tsdf';
import { createAsyncStorageAdapter } from 'tsdf/async-storage';

const driver: AsyncStorageDriver = {
  // Stable id, needed to list this adapter's deleted stores in `removedStores`
  storageId: 'custom-store',
  get: (scope, key) => customStore.get(scope, key),
  set: (scope, key, value) => customStore.set(scope, key, value),
  remove: (scope, key) => customStore.remove(scope, key),
  listKeys: (scope) => customStore.listKeys(scope),
  clear: (scope) => customStore.clear(scope),
  listScopes: (sessionKey) => customStore.listScopes(sessionKey),
  listScopesWithKnownRecordKeys: (sessionKey) =>
    customStore.listScopesWithKnownRecordKeys(sessionKey),
  getMany: (scope, keys) => customStore.getMany(scope, keys),
  setMany: (scope, entries) => customStore.setMany(scope, entries),
  removeMany: (scope, keys) => customStore.removeMany(scope, keys),
};

const customPersistentStorage = createAsyncStorageAdapter(driver);
```

Driver methods should preserve the JSON-compatible values TSDF gives them, isolate data by the full namespace scope, and implement bulk methods consistently with their single-record equivalents. `listScopes(...)` and `listScopesWithKnownRecordKeys(...)` are required for cleanup, session clearing, and offline protected-key restoration. The optional `storageId` must stay the same across page loads and be unique among the app's adapters; it is only needed to list stores persisted with this adapter in the store manager's `removedStores`.

### Changing a store's adapter

Each adapter is a separate storage. A store only reads what was written through its current `adapter`, so after the adapter changes the store starts with an empty cache and refetches. Nothing is migrated between adapters.

Moving a store from `'local-sync'` to an async adapter:

- The first time the store runs with the async adapter, TSDF removes everything that store left in `localStorage` for the active session (cached entries and their metadata) during browser idle time. Other stores, other sessions and non-TSDF keys are not touched; entries a store left under another session key are only removed by the regular expiry while some store still uses `'local-sync'`.
- Detecting this costs one `localStorage.getItem` of a missing key per store namespace at startup for stores that never used `localStorage`; the removal only runs when that read finds something.
- Queued offline work is never deleted. Offline mutations and pending resolutions are stored through the store's adapter, so they do not follow the store to the new adapter and are only replayed while the store uses `'local-sync'`. When `localStorage` still holds any for the store, TSDF keeps all of that store's `localStorage` entries and reports an error through `onPersistentStorageError` on every page load. Let the offline queue drain before changing the adapter of an offline-enabled store, or roll the adapter back so the queue can replay; the leftovers are removed on the next load after the queue is empty.
- A tab still running the previous app version keeps working: it serves its data from memory and writes its entries to `localStorage` again. They are removed the next time the new version starts.

Moving a store from an async adapter to `'local-sync'`, or from one async adapter to another, does not clean the previous adapter. Its old entries are still removed by that adapter's regular expiry while another store keeps using it; once no store uses that adapter anymore, they stay there.

### Deleting a store

Deleting a store from the app leaves its persisted data behind: nothing reads it anymore, regular expiry only covers it while another store keeps using the same adapter, and it never removes list queries or offline data. Declare deleted stores in the store manager so TSDF removes their data:

```ts
import { createStoreManager } from 'tsdf';
import { indexedDbPersistentStorage } from 'tsdf/indexed-db-storage';

const storeManager = createStoreManager({
  // ...
  removedStores: [
    { id: 'legacy-settings', adapter: 'local-sync' },
    { id: 'old-feed', adapter: indexedDbPersistentStorage },
  ],
});
```

- Each entry names the deleted store's `id` and the `adapter` it persisted with. Add one entry per adapter when the store used more than one. Naming the adapter lets TSDF clean it even when no remaining store uses it, without bundling or opening adapters the app does not import.
- Once, during browser idle time after startup, TSDF removes everything each listed store persisted with that adapter, in every session: cached entries and their metadata, offline entity records, and any queued offline mutations or pending resolutions. Other stores and non-TSDF keys are not touched.
- Unsent offline work can no longer be replayed once its store is deleted, so it is removed too, and the number of records dropped is reported once per store through the manager's `onPersistentStorageError`.
- TSDF then records each cleaned id and adapter pair in a small `localStorage` marker. Every later startup reads that marker once during idle time and stops there; apps without `removedStores` pay nothing. Adding an adapter for an id already cleaned from another adapter still cleans the new one. Entries can be dropped from `removedStores` once every user has run a version that includes them.
- When an adapter fails (for example a file it cannot delete), the error is reported through `onPersistentStorageError` and only that adapter is retried on the next page load; the other adapters stay marked as done.
- A store attached to the manager cannot use an id listed in `removedStores`: creating it throws, since the cleanup would remove its data.
- Custom async adapters are supported when created with `createAsyncStorageAdapter` from a driver with a `storageId`: a stable id, unique among the app's adapters, that TSDF uses to remember the cleanup across page loads. For other adapters TSDF reports an error through `onPersistentStorageError` on every page load and removes nothing, until the entry names a supported adapter.
- The cleanup runs once per id and adapter. A tab still running the previous app version can write the deleted store's entries again after the cleanup; those are only removed by the adapter's regular expiry while another store keeps using it.
- In `localStorage`, a store is found through its metadata entries, so a list-query store whose every cached query was empty (and that cached no items) is not found; those small query entries stay.
- Offline uploads belong to the session, not to a store, and are not removed.

## Example configuration

```ts
import { rc_object, rc_string } from 'runcheck';
import { createDocumentStore, createStoreManager } from 'tsdf';

type Settings = { id: string; theme: string };

const getSessionKey = () => (userId ? `tenant:${userId}` : false);

const storeManager = createStoreManager({
  getSessionKey,
  errorNormalizer: normalizeError,
  lowPriorityThrottleMs: 40 * 60 * 1_000,
  baseCoalescingWindowMs: 16,
  blockWindowClose: null,
  onPersistentStorageError: (error) => {
    console.error('TSDF persistence failed', error);
  },
  offlineSession: {
    network: { enabled: true },
    mutationQueueing: { network: 'allow', outage: 'allow' },
  },
});

const settingsStore = createDocumentStore<Settings>({
  id: 'document-settings',
  storeManager,
  fetchFn: (signal) => api.getSettings(signal),
  persistentStorage: {
    adapter: 'local-sync',
    version: 2,
    schema: rc_object({ id: rc_string(), theme: rc_string() }),
    onPersistentStorageError: (error) => {
      console.error('Settings persistence failed', error);
    },
    offline: {},
  },
});
```

## Lifecycle behavior

- On successful fetch, stores save to persistence after debounce (approximately 1s).
- On startup/reload, stores attempt restore and set `refetchOnMount: 'lowPriority'` so stale data is revalidated.
- When a store instance is permanently discarded, call `store.dispose()` to release listeners, browser-tab coordination, and store-manager registration.
- Invalid or incompatible cache entries are removed automatically.
- Expired entries are removed by a periodic scan:
  - `local-sync`: ~1 week old entries
  - `opfsPersistentStorage`: ~2 weeks old entries
  - `indexedDbPersistentStorage`: ~2 weeks old entries
- Entries referenced by queued offline mutations are protected from expiry until that queued work is replayed or discarded.
- Expiry runs for an adapter only while at least one store uses it, and then covers every entry in that adapter, including ones left by stores that moved elsewhere. See [Changing a store's adapter](#changing-a-stores-adapter).

## Preload APIs

These are useful in components that need control over when async hydration should happen.

### Document store

- `preloadPersistentStorage(): Promise<void>`

### Collection store

- `preloadItemFromStorage(params): Promise<PersistentStoragePreloadResult<ItemPayload>[]>`
- `params`: single payload or payload array.

### List query store

- `preloadQueryFromStorage(payloads): Promise<PersistentStoragePreloadResult<QueryPayload>[]>`
- `preloadItemFromStorage(params): Promise<PersistentStoragePreloadResult<ItemPayload>[]>`
- `params`: single payload or payload array.

When list-query offline persistence is enabled, `usePendingOfflineItems()` can
also restore pending offline item state from persistence without mounting
`useListQuery()`. This is especially useful for offline-first screens that boot
directly into queued work.

`preload*` returns `preloaded` boolean for each payload.

When the selected adapter does not support async preload, preload methods report errors to `onPersistentStorageError` and return `preloaded: false`.

## Cache retention controls

- `maxBytes` limits the serialized storage budget for collection items.
- `maxItemBytes` limits the serialized storage budget for list-query items.
- `maxQueryBytes` limits the serialized storage budget for list-query query entries.
- `maxQuerySize` limits how many items each cached query can keep.
- Pinned entries are never evicted.
- `ignoreItems` removes/blocks entries from being persisted or hydrated.
  - Can be an explicit list or predicate.
  - Takes precedence over pinned lists.

### Cached list queries that lost rows

Items and queries are stored and evicted separately, so a cached list query can outlive some of its rows: `maxItemBytes` evicts the least recently read item entries while the query entry stays, and an item entry that fails `schema` (or is now covered by `ignoreItems`) is discarded when it is read.

A cached query is restored as a loaded query (`status: 'success'`, shown immediately and revalidated in the background) only when every row it was saved with can be restored. When rows are missing, the rows that are left are still restored, but the query is not restored as loaded (`wasLoaded: false`), so the shorter — or empty — list is never presented as the complete one:

- Online, hooks report `status: 'loading'` and fetch the query right away, as for a query that was never cached. The remaining rows are available in `items` meanwhile (stores using [Partial Resources](./partial-resources.md) hide items while loading, as usual).
- Offline, the fetch fails with the offline error: hooks report `status: 'error'` with `error.id === 'offline'` and the remaining rows in `items`, so a screen can show what is left of the list together with a notice that it is incomplete. `awaitListQueryFetch` returns the offline error instead of the incomplete list. A loaded list doesn't load more rows from such a cached list while offline (`loadMore` is skipped and `hasMore` is `false`), since its next rows may come after a missing one.
- The stored query is left as it is until the list is fetched again, so the next start sees the same state. With `local-sync`, the query entry rewritten after an eviction lists only the rows that are left and is flagged (`"m": true`) as incomplete.

`maxQuerySize` is different: it deliberately keeps only the first rows of a query and restores it as loaded with `hasMore: true`.

## Clearing stored data

- `clearSessionStorage(sessionKey, adapter)`:
  remove all TSDF entries for one session and adapter.
- `clearAllSessionStorage(sessionKey)`:
  remove TSDF entries for one session across the built-in `local-sync`, OPFS, and IndexedDB adapters.

Use these on logout, user switch, or explicit privacy actions. They clear every store of the session, so do not use them to clean up after a deleted store: declare it in `removedStores` instead (see [Deleting a store](#deleting-a-store)).
