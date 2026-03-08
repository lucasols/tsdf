# Persistent Storage

TSDF can persist cached data across page reloads and browser sessions through the optional `persistentStorage` option on each store type.

See also: [Document Store](./document-store.md) | [Collection Store](./collection-store.md) | [List Query Store](./list-query-store.md)

## What it does

- Loads cached entries before network fetches when available.
- Persists successful fetch results back to local storage.
- Invalidates and drops cache entries when schema or version checks fail.
- Uses session scoped keys, so data is isolated per tenant/account.

## Public API

Exported from `tsdf`:

| Export                                                                                                       | Description                                                 |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `PersistentStorageSchema`                                                                                    | Schema type supported by cache validation                   |
| `StorageBackend`                                                                                             | `'localStorage' \| 'opfs'`                                  |
| `DocumentPersistentStorageConfig` / `CollectionPersistentStorageConfig` / `ListQueryPersistentStorageConfig` | Store-level persistence config types                        |
| `PersistentStoragePreloadResult<Payload>`                                                                    | Return shape for preload methods                            |
| `clearSessionStorage(sessionKey, backend)`                                                                   | Clears all TSDF entries for one session/backend             |
| `clearAllSessionStorage(sessionKey)`                                                                         | Clears all TSDF entries for one session across all backends |

## Configuration

Each store accepts `persistentStorage` in options:

| Store            | Config Type                                                              |
| ---------------- | ------------------------------------------------------------------------ |
| Document Store   | `DocumentPersistentStorageConfig<State>`                                 |
| Collection Store | `CollectionPersistentStorageConfig<ItemState, ItemPayload>`              |
| List Query Store | `ListQueryPersistentStorageConfig<ItemState, QueryPayload, ItemPayload>` |

Common options (applies to all store configs):

| Option                            | Required | Description                                             |
| --------------------------------- | -------- | ------------------------------------------------------- |
| `storeName`                       | Yes      | Unique name of the persisted store namespace.           |
| `schema`                          | Yes      | Schema used to validate restored data.                  |
| `backend`                         | No       | `'opfs'` by default.                                    |
| `version`                         | No       | Cache version; bump to invalidate old entries.          |
| `onPersistentStorageError(error)` | No       | Callback for write/read failures (quota, decode, etc.). |

Store-specific options:

| Store            | Additional options                                                                      |
| ---------------- | --------------------------------------------------------------------------------------- |
| Collection Store | `maxItems`, `pinnedItems`, `ignoreItems`                                                |
| List Query Store | `maxItems`, `maxQueries`, `maxQuerySize`, `pinnedItems`, `pinnedQueries`, `ignoreItems` |

> `PersistentStorageConfig` uses the store's existing `getSessionKey` automatically. When `getSessionKey` returns `false`, no persistence operations run.

## Backend behavior

### `localStorage`

- Default behavior when `backend: 'localStorage'`.
- Can hydrate synchronously during initial state creation for `DocumentStore`.
- `CollectionStore` and `ListQueryStore` use lazy hydration for unknown entries from initial keys scan.
- Writes are debounced and may be dropped if serialization or quota errors occur.

### `opfs`

- Default behavior for all stores.
- Uses `FileSystemAccess`-backed persistent storage.
- Hydration is asynchronous, and can be triggered explicitly with preload APIs.

## Example configuration

```ts
import { rc_object, rc_string } from 'runcheck';
import { createDocumentStore } from 'tsdf';

type Settings = { id: string; theme: 'light' | 'dark' };

const settingsStore = createDocumentStore<Settings>({
  id: 'document-settings',
  getSessionKey: () => (userId ? `tenant:${userId}` : false),
  fetchFn: (signal) => api.getSettings(signal),
  errorNormalizer: normalizeError,
  lowPriorityThrottleMs: 2000,
  baseCoalescingWindowMs: 100,
  backgroundCoalescingWindowMultiplier: 2,
  blockWindowClose: null,
  persistentStorage: {
    storeName: 'settings',
    backend: 'opfs',
    version: 2,
    schema: rc_object({
      data: rc_object({ id: rc_string(), theme: rc_string() }),
    }),
    onPersistentStorageError: (error) => {
      console.error('Settings persistence failed', error);
    },
  },
});
```

## Lifecycle behavior

- On successful fetch, stores save to persistence after debounce (approximately 1s).
- On startup/reload, stores attempt restore and set `refetchOnMount: 'lowPriority'` so stale data is revalidated.
- Invalid or incompatible cache entries are removed automatically.
- Expired entries are removed by a periodic scan:
  - `localStorage`: ~1 week old entries
  - `opfs`: ~2 weeks old entries

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

`preload*` returns `preloaded` boolean for each payload.

When the selected backend does not support async preload, preload methods report errors to `onPersistentStorageError` and return `preloaded: false`.

## Cache retention controls

- `maxItems` limits how many cached entries are kept.
- `maxQueries` limits number of cached list queries (list query store only).
- `maxQuerySize` limits how many items each cached query can keep (list query store only).
- Pinned entries are never evicted.
- `ignoreItems` removes/blocks entries from being persisted or hydrated.
  - Can be an explicit list or predicate.
  - Takes precedence over pinned lists.

## Clearing stored data

- `clearSessionStorage(sessionKey, backend)`:
  remove all TSDF entries for one session/backend.
- `clearAllSessionStorage(sessionKey)`:
  remove TSDF entries for one session across both backends.

Use these on logout, user switch, or explicit privacy actions.
