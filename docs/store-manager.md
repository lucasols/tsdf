# Store Manager

`createStoreManager(...)` creates the shared session boundary for TSDF stores. Every store requires one manager so data can be scoped by tenant/account, errors can be normalized consistently, and global store/offline APIs can coordinate across store instances.

See also: [Persistent Storage](./persistent-storage.md) | [Offline](./offline.md) | [Browser Tabs Sync](./browser-tabs-sync.md)

## Creating A Manager

```ts
import { createStoreManager } from 'tsdf';

const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  getAppVersion: () => BUILD_VERSION,
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
  debugLogger: true,
});
```

Options:

| Option                        | Required | Description                                                                                                                                                        |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getSessionKey`               | Yes      | Returns the active tenant/account key. Return `false` while no session is ready.                                                                                   |
| `getAppVersion`               | No       | Returns a stable build/release version that namespaces browser-tab sync so different deployments cannot exchange fetch activity or snapshots.                      |
| `errorNormalizer`             | Yes      | Converts thrown `Error` values into TSDF's shared `StoreError` shape.                                                                                              |
| `lowPriorityThrottleMs`       | No       | Default minimum interval between low-priority fetches for attached stores. Defaults to 40 minutes (`2_400_000ms`).                                                 |
| `baseCoalescingWindowMs`      | No       | Default window to group fetch requests for attached stores. Defaults to `16ms`.                                                                                    |
| `backgroundCoalescingDelayMs` | No       | Extra browser-tab coalescing delay applied only while a tab is in the background. Defaults to `3000ms`.                                                            |
| `dynamicRealtimeThrottleMs`   | No       | Default adaptive throttle for real-time updates in attached stores. Defaults to `100ms` focused and `1000ms` in the background. Store options override it.         |
| `blockWindowClose`            | No       | Shared window-close blocker for mutations in attached stores. Defaults to `null`.                                                                                  |
| `revalidateOnWindowFocus`     | No       | Default focus revalidation policy for attached stores. Store options override it.                                                                                  |
| `onMutationError`             | No       | Global fallback for mutation failures when a store does not provide its own handler.                                                                               |
| `onPersistentStorageError`    | No       | Global fallback for persistent storage failures when a store does not provide its own handler.                                                                     |
| `debugLogger`                 | No       | Enables verbose development-only browser-tab sync, focus revalidation, and persistent-storage debug logs. Pass `true` or a logger function.                        |
| `logger`                      | No       | Enables low-volume production-safe logs such as persistent-storage quota cleanup. Defaults to console logging; pass `false` to disable or a function to customize. |
| `offlineSession`              | No       | Shared offline config used by stores with `persistentStorage.offline`.                                                                                             |
| `removedStores`               | No       | Stores deleted from the app whose persisted data TSDF removes once, in every session. See [Deleting a store](./persistent-storage.md#deleting-a-store).            |

The session key is used by browser-tab sync, persistent storage, and offline state. Stores with the same `id` but different session keys are isolated.

For apps that can have tabs from different deployments open at the same time, provide `getAppVersion` and return the same stable build version used by your error tracking or release tooling. TSDF evaluates it once when the manager is created and includes the result in every browser-tab sync channel, including manager presence and offline-session coordination. Tabs on different versions then fetch independently and cannot apply each other's snapshots. This option does not version persistent storage; continue using each store's `persistentStorage.version` when its persisted data shape changes.

Stores inherit the manager's `lowPriorityThrottleMs`, `baseCoalescingWindowMs`, and `dynamicRealtimeThrottleMs` unless they provide their own store-level overrides. `backgroundCoalescingDelayMs` and `blockWindowClose` are manager-only so browser-tab background coordination and window-close mutation protection stay consistent across attached stores. The built-in `dynamicRealtimeThrottleMs` default returns `100ms` while focused and `1000ms` while the window is in the background.

Store-level options can explicitly disable inherited defaults when the option supports disabling: use `revalidateOnWindowFocus: false`, `onMutationError: null`, or `persistentStorage.onPersistentStorageError: null`.

## Debug Logging

Pass `debugLogger: true` to log browser-tab sync operations, focus revalidation decisions, and persistent-storage operations through `console.log`, `console.warn`, and `console.error` in development. Browser-tab sync logs include lifecycle, leader changes, publish/receive events, and skipped messages. Focus revalidation logs report when `revalidateOnWindowFocus` triggers, is dynamically disabled, or is skipped because real-time updates own freshness. Store data sync uses store-specific channels, while tab-presence status uses one shared `presence` channel per manager/session. Presence prioritizes the focused tab; background tabs announce open/focus/blur changes and keep their last known fallback rank during quiet periods. Async persistent storage adapters emit timed `adapter-operation` entries with `durationMs` so slow OPFS, IndexedDB, or custom driver paths can be inspected.

Low-volume production-safe signals are logged by default through `console.log`, `console.warn`, and `console.error`. Today this includes persistent-storage `quota-cleanup` entries. Pass `logger: false` to disable them, or pass a function to route them to your own tooling.

```ts
const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  errorNormalizer: normalizeError,
  debugLogger: ({ level, message, details }) => {
    observability[level](message, details);
  },
  logger: ({ level, message, details }) => {
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
- `onTransportReconnect()` signals a shared real-time transport reconnect to all registered stores. It is ignored while the offline session is in offline mode: stores revalidate by themselves when they recover (see [Revalidation After Recovering](./offline.md#revalidation-after-recovering)).

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

Manager offline methods are safe to call even when no offline session is configured. In that case they return empty/default state, and upload helpers and `resolveOfflineResolution(...)` return `Result.err(...)` where applicable.

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

Resolution actions:

- `resolveOfflineResolution(resolutionId, 'retry' | 'discard')` applies a generic action to any resolution of the session by delegating to the registered store that owns it, so session-wide UI does not need the store instance or the operation name

```ts
const result = await storeManager.resolveOfflineResolution(
  resolution.id,
  'discard',
);
if (!result.ok) console.warn(result.error.code, result.error.message);
```

It resolves to a `Result<void, OfflineResolutionActionError>` instead of throwing. `error.code` tells why the action was not applied: `resolution-not-found`, `store-not-registered` (the owning store was not created with this manager), `retry-not-supported` (conflict records), `resolution-blocked`, `offline-not-configured`, or `action-failed`. See [Offline](./offline.md#resolving-from-a-session-wide-ui) for details. `requeue` and `commit` stay on the owning store's `resolveOfflineResolution(...)`.

## Upload APIs

When `offlineSession.uploads` is configured, the manager also owns session-scoped upload storage and resolution:

```ts
await storeManager.saveOfflineUpload({
  id: 'avatar',
  file,
  // Optional per-upload data for the session `upload` transport.
  metadata: { kind: 'profile', userId },
});
const resolved = await storeManager.resolveOfflineUpload('avatar');
```

Upload methods:

- `saveOfflineUpload({ id, file, metadata? })`
- `replaceOfflineUpload({ id, file, metadata? })` keeps the saved metadata unless new `metadata` is passed
- `loadOfflineUpload(id)`
- `deleteOfflineUpload(id)`
- `resolveOfflineUpload(id)` uploads the staged file if needed and returns its final ref
- `resolveOfflineUploads(ids)` does the same for several ids and fails as a whole with the first transport error
- `useOfflineUploads()`

When the `upload` transport fails, `resolveOfflineUpload(s)` returns `Result.err(error)` with the transport error and the upload becomes `failed` (`lastError` set). The session failure classifiers are not consulted and nothing is retried automatically; calling the method again runs the upload again, and `lastError` is cleared once it succeeds. Uploads that run as a dependency of a replayed offline operation are classified and retried by the session instead. See [Offline: Upload failure handling](./offline.md#upload-failure-handling).

`metadata` is a JSON-serializable `ValidPayload` persisted with the upload. The `upload` transport receives it in its context and `getOfflineUploads()` / `useOfflineUploads()` expose it on each `OfflineUpload`. See [Offline: Upload metadata](./offline.md#upload-metadata).

Staged uploads are deleted automatically when the last queued mutation or resolution record that depends on them leaves the queue (replayed, discarded, superseded or cancelled). `deleteOfflineUpload(id)` is only needed for uploads no queued mutation used, which otherwise expire after a week online, and it returns an error while queued work still references the upload. See [Offline: Upload lifecycle](./offline.md#upload-lifecycle).

Most upload methods return `Result` objects so UI can branch on `result.ok` without catching thrown errors.
