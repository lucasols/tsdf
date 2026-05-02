# Store Manager

`createStoreManager(...)` creates the shared session boundary for TSDF stores. Every store requires one manager so data can be scoped by tenant/account, errors can be normalized consistently, and global store/offline APIs can coordinate across store instances.

See also: [Persistent Storage](./persistent-storage.md) | [Offline](./offline.md) | [Browser Tabs Sync](./browser-tabs-sync.md)

## Creating A Manager

```ts
import { createStoreManager } from 'tsdf';

const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  errorNormalizer: (error) => ({
    code: 500,
    id: 'unknown-error',
    message: error.message,
  }),
});
```

Options:

| Option            | Required | Description                                                                      |
| ----------------- | -------- | -------------------------------------------------------------------------------- |
| `getSessionKey`   | Yes      | Returns the active tenant/account key. Return `false` while no session is ready. |
| `errorNormalizer` | Yes      | Converts thrown `Error` values into TSDF's shared `StoreError` shape.            |
| `offlineSession`  | No       | Shared offline config used by stores with `persistentStorage.offline`.           |

The session key is used by browser-tab sync, persistent storage, and offline state. Stores with the same `id` but different session keys are isolated.

## Store Registry

The manager tracks attached stores:

```ts
storeManager.getAllStoreIds();
storeManager.resetAll(['document-current-user']);
```

- `getAllStoreIds()` returns registered logical store ids.
- `resetAll(ignoreStores)` resets all registered stores except the ignored ids.

Call each store's `dispose()` when the store instance is permanently discarded so it can unregister listeners and manager state.

## Offline Session

Pass `offlineSession` when stores need offline queueing or session-level offline reads:

```ts
const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  errorNormalizer: normalizeError,
  offlineSession: {
    network: { enabled: true },
    mutationQueueing: { network: 'allow', outage: 'allow' },
  },
});
```

Manager offline methods are safe to call even when no offline session is configured. In that case they return empty/default state, and upload helpers return `Result.err(...)` where applicable.

## Offline Status APIs

Read session-wide offline state:

```tsx
const status = storeManager.useOfflineStatus();
const entities = storeManager.useOfflineEntities();
const resolutions = storeManager.useOfflineResolutions();
```

Synchronous equivalents:

- `getOfflineConfig()`
- `getOfflineRuntimeConfig()`
- `getOfflineStatus()`
- `getOfflineEntities()`
- `getOfflineResolutions()`
- `getOfflineUploads()`

Runtime controls:

- `setOfflineRuntimeConfig(update)` returns a `Result<void, Error>`
- `resetOfflineRuntimeConfig()` restores the static `offlineSession` controls

## Upload APIs

When `offlineSession.uploads` is configured, the manager also owns session-scoped upload storage and resolution:

```ts
await storeManager.saveOfflineUpload({ id: 'avatar', file });
const resolved = await storeManager.resolveOfflineUpload('avatar');
```

Upload methods:

- `saveOfflineUpload({ id, file })`
- `replaceOfflineUpload({ id, file })`
- `loadOfflineUpload(id)`
- `deleteOfflineUpload(id)`
- `resolveOfflineUpload(id)`
- `resolveOfflineUploads(ids)`
- `useOfflineUploads()`

Most upload methods return `Result` objects so UI can branch on `result.ok` without catching thrown errors.
