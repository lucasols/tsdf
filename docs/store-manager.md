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
  lowPriorityThrottleMs: 40 * 60 * 1_000,
  baseCoalescingWindowMs: 16,
  backgroundCoalescingDelayMs: 3_000,
  dynamicRealtimeThrottleMs: ({ lastFetchDuration, windowIsNotFocused }) =>
    windowIsNotFocused ? lastFetchDuration * 10 : lastFetchDuration * 2,
  blockWindowClose: null,
  revalidateOnWindowFocus: true,
  onMutationError: (error) => {
    console.error('TSDF mutation failed', error);
  },
  onPersistentStorageError: (error) => {
    console.error('TSDF persistence failed', error);
  },
  debug: true,
});
```

Options:

| Option                        | Required | Description                                                                                                                                                |
| ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getSessionKey`               | Yes      | Returns the active tenant/account key. Return `false` while no session is ready.                                                                           |
| `errorNormalizer`             | Yes      | Converts thrown `Error` values into TSDF's shared `StoreError` shape.                                                                                      |
| `lowPriorityThrottleMs`       | No       | Default minimum interval between low-priority fetches for attached stores. Defaults to 40 minutes (`2_400_000ms`).                                         |
| `baseCoalescingWindowMs`      | No       | Default window to group fetch requests for attached stores. Defaults to `16ms`.                                                                            |
| `backgroundCoalescingDelayMs` | No       | Extra browser-tab coalescing delay applied only while a tab is in the background. Defaults to `3000ms`.                                                    |
| `dynamicRealtimeThrottleMs`   | No       | Default adaptive throttle for real-time updates in attached stores. Defaults to `100ms` focused and `1000ms` in the background. Store options override it. |
| `blockWindowClose`            | No       | Shared window-close blocker for mutations in attached stores. Defaults to `null`.                                                                          |
| `revalidateOnWindowFocus`     | No       | Default focus revalidation policy for attached stores. Store options override it.                                                                          |
| `onMutationError`             | No       | Global fallback for mutation failures when a store does not provide its own handler.                                                                       |
| `onPersistentStorageError`    | No       | Global fallback for persistent storage failures when a store does not provide its own handler.                                                             |
| `debug`                       | No       | Enables browser-tab sync, focus revalidation, and persistent-storage debug logs. Pass `true` or a logger function.                                         |
| `offlineSession`              | No       | Shared offline config used by stores with `persistentStorage.offline`.                                                                                     |

The session key is used by browser-tab sync, persistent storage, and offline state. Stores with the same `id` but different session keys are isolated.

Stores inherit the manager's `lowPriorityThrottleMs`, `baseCoalescingWindowMs`, and `dynamicRealtimeThrottleMs` unless they provide their own store-level overrides. `backgroundCoalescingDelayMs` and `blockWindowClose` are manager-only so browser-tab background coordination and window-close mutation protection stay consistent across attached stores. The built-in `dynamicRealtimeThrottleMs` default returns `100ms` while focused and `1000ms` while the window is in the background.

Store-level options can explicitly disable inherited defaults when the option supports disabling: use `revalidateOnWindowFocus: false`, `onMutationError: null`, or `persistentStorage.onPersistentStorageError: null`.

## Debug Logging

Pass `debug: true` to log browser-tab sync operations, focus revalidation decisions, and persistent-storage operations through `console.log`, `console.warn`, and `console.error`. Browser-tab sync logs include lifecycle, leader changes, publish/receive events, and skipped messages. Focus revalidation logs report when `revalidateOnWindowFocus` triggers, is dynamically disabled, or is skipped because real-time updates own freshness. Store data sync uses store-specific channels, while tab-presence status uses one shared `presence` channel per manager/session. Presence prioritizes the focused tab; background tabs announce open/focus/blur changes and keep their last known fallback rank during quiet periods. Async persistent storage adapters emit timed `adapter-operation` entries with `durationMs` so slow OPFS, IndexedDB, or custom driver paths can be inspected.

```ts
const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  errorNormalizer: normalizeError,
  debug: ({ level, message, details }) => {
    observability[level](message, details);
  },
});
```

## Store Registry

The manager tracks attached stores:

```ts
storeManager.getAllStoreIds();
storeManager.resetAll(['document-current-user']);
storeManager.onTransportReconnect();
```

- `getAllStoreIds()` returns registered logical store ids.
- `resetAll(ignoreStores)` resets all registered stores except the ignored ids.
- `onTransportReconnect()` signals a shared real-time transport reconnect to all registered stores.

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
