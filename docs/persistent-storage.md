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
| `PersistentStoragePreloadResult<Payload>`                                                                    | Return shape for preload methods                                 |
| `clearSessionStorage(sessionKey, adapter)`                                                                   | Clears all TSDF entries for one session/adapter                  |
| `clearAllSessionStorage(sessionKey)`                                                                         | Clears all TSDF entries for one session across built-in adapters |
| `localPersistentStorage`                                                                                     | Built-in localStorage helper used by the `'local-sync'` adapter  |
| `opfsPersistentStorage` / `indexedDbPersistentStorage`                                                       | Built-in async storage adapters                                  |
| `createIndexedDbPersistentStorage(options?)`                                                                 | Creates an IndexedDB adapter, optionally with a database name    |
| `createAsyncStorageAdapter(driver)`                                                                          | Wraps a custom async storage driver                              |

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

> `persistentStorage` automatically reuses the store's existing `id` for its storage namespace and the store manager's `getSessionKey` for session scoping. When `getSessionKey` returns `false`, no persistence operations run.

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

### `local-sync`

- Uses managed `localStorage` entries.
- Can hydrate synchronously during initial state creation for `DocumentStore`.
- `CollectionStore` and `ListQueryStore` use lazy hydration for unknown entries from initial keys scan.
- Writes are debounced and may be dropped if serialization or quota errors occur.

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

Use `createIndexedDbPersistentStorage({ databaseName })` when an app needs an isolated IndexedDB database.

### Custom async adapters

Use `createAsyncStorageAdapter(driver)` only when the built-in OPFS and IndexedDB adapters are not a fit. It wraps an `AsyncStorageDriver`, which is the low-level async backend contract used by TSDF persistence internals.

A driver is responsible for storing raw records by logical namespace:

```ts
import { createAsyncStorageAdapter } from 'tsdf';
import type { AsyncStorageDriver } from 'tsdf';

const driver: AsyncStorageDriver = {
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

Driver methods should preserve the JSON-compatible values TSDF gives them, isolate data by the full namespace scope, and implement bulk methods consistently with their single-record equivalents. `listScopes(...)` and `listScopesWithKnownRecordKeys(...)` are required for cleanup, session clearing, and offline protected-key restoration.

## Example configuration

```ts
import { rc_object, rc_string } from 'runcheck';
import { createDocumentStore, createStoreManager } from 'tsdf';

type Settings = { id: string; theme: string };

const getSessionKey = () => (userId ? `tenant:${userId}` : false);

const storeManager = createStoreManager({
  getSessionKey,
  errorNormalizer: normalizeError,
  lowPriorityThrottleMs: 5,
  baseCoalescingWindowMs: 10,
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

## Clearing stored data

- `clearSessionStorage(sessionKey, adapter)`:
  remove all TSDF entries for one session and adapter.
- `clearAllSessionStorage(sessionKey)`:
  remove TSDF entries for one session across the built-in `local-sync`, OPFS, and IndexedDB adapters.

Use these on logout, user switch, or explicit privacy actions.
