# Offline

TSDF's offline support is built on top of [Persistent Storage](./persistent-storage.md). It lets offline-enabled mutations fall back to a durable queue, keeps optimistic local state visible, replays queued work when the session recovers, and exposes queue/status data for UI.

See also: [Store Manager](./store-manager.md) | [Persistent Storage](./persistent-storage.md) | [Mutations](./mutations.md) | [Hooks](./hooks.md#usependingofflineitems)

## Enabling Offline

Offline has two pieces:

1. A shared `offlineSession` on `createStoreManager(...)`.
2. Store-local `persistentStorage.offline` config, optionally with operation definitions.

```ts
import {
  createListQueryStore,
  createStoreManager,
  type DefineListQueryOfflineOperations,
  type DefineOfflineOperation,
} from 'tsdf';

type User = { id: number; name: string };
type UserPayload = { id: number };
type RenameInput = { id: number; name: string };
type UsersQuery = { teamId: string };

type UserOfflineOperations = DefineListQueryOfflineOperations<
  User,
  UsersQuery,
  UserPayload,
  { renameUser: DefineOfflineOperation<RenameInput> }
>;

const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  errorNormalizer: normalizeError,
  lowPriorityThrottleMs: 40 * 60 * 1_000,
  baseCoalescingWindowMs: 16,
  blockWindowClose: null,
  offlineSession: {
    network: { enabled: true },
    mutationQueueing: { network: 'allow', outage: 'allow' },
  },
});

const userStore = createListQueryStore<
  User,
  UsersQuery,
  UserPayload,
  false,
  false,
  UserOfflineOperations
>({
  id: 'users',
  storeManager,
  fetchListFn: (query, size, { signal }) => api.listUsers(query, size, signal),
  fetchItemFn: (payload, { signal }) => api.getUser(payload, signal),
  getItemKey: (payload) => payload.id,
  persistentStorage: {
    adapter: 'local-sync',
    schema: userSchema,
    itemPayloadSchema: userPayloadSchema,
    queryPayloadSchema: usersQuerySchema,
    offline: {
      operations: {
        renameUser: {
          inputSchema: renameUserSchema,
          kind: 'update',
          getEntityRefs: ({ input }) => [{ id: input.id }],
          execute: ({ input }) => api.renameUser(input),
          onSuccessExecute: ({ input }) => {
            userStore.updateItemState({ id: input.id }, (user) => ({
              ...user,
              name: input.name,
            }));
          },
        },
      },
    },
  },
});
```

`persistentStorage.offline: {}` is valid when a store only needs session-level offline read/status behavior and has no store-local queued mutation operations.

## Queuing Mutations

Use the normal `performMutation(...)` API and add an `offline` descriptor:

```ts
await userStore.performMutation(
  { id: 1 },
  {
    optimisticUpdate: () => {
      userStore.updateItemState({ id: 1 }, (user) => ({
        ...user,
        name: 'Ada',
      }));
    },
    mutation: () => api.renameUser({ id: 1, name: 'Ada' }),
    offline: { operation: 'renameUser', input: { id: 1, name: 'Ada' } },
  },
);
```

When the online mutation succeeds, the result value is `{ kind: 'online', data }`. When TSDF queues the mutation for offline replay, the result value is `{ kind: 'queued' }`.

## Operation Definitions

All offline operations define:

- `inputSchema` - Validates mutation input before it enters the queue and again when restored.
- `kind` - `create`, `update`, or `delete`; TSDF derives each affected entity's lifecycle from this.
- `execute(ctx)` - Sends queued work to the server during replay.

Collection and list-query operations also define:

- `getEntityRefs({ input })` - Returns affected item/entity refs.
- `dependsOn({ input })` - Optional dependencies on other offline entities.

Optional replay behavior:

- `onSuccessExecute(ctx)` - Updates live store state after replay succeeds.
- `getServerSnapshot(ctx)` - Loads fresh server state before replay checks.
- `shouldSkipSync(ctx)` - Drops queued work when the server already reflects it.
- `conflictHandling` - Detects conflicts and creates manual resolution records.
- `accumulation` - Merges newer queued inputs into an existing queued mutation.
- `supersedes` - Prunes older queued work for the same entity.

Create flows for collection and list-query stores can use `tempEntity` or `tempEntities` to insert optimistic entities with temporary payloads and reconcile them to final server payloads after replay. Document stores do not support temp entities.

## Conflict Resolution

Stores expose resolution APIs:

```ts
const resolutions = userStore.getOfflineResolutions();

await userStore.resolveOfflineResolution(resolutions[0].id, 'renameUser', {
  action: 'requeue',
  input: { id: 1, name: 'Ada resolved' },
});
```

Supported resolution actions include:

- `discard` - Drop the resolution record.
- `requeue` - Queue replacement input for an operation conflict.
- `commit` - Accept an externally completed resolution result.
- `retry` - Retry a retry-exhausted record.

Use `parseOfflineResolutionConflict(resolution)` to narrow a persisted resolution back to the operation-specific conflict/input type before rendering a manual resolution UI.

## Reading Offline State

Use manager-level APIs for session-wide UI:

```tsx
const status = storeManager.useOfflineStatus();
const entities = storeManager.useOfflineEntities();
const resolutions = storeManager.useOfflineResolutions();
```

Equivalent global helpers are exported for code that only has a session key:

```ts
import {
  getGlobalOfflineStatus,
  useGlobalOfflineEntities,
  useGlobalOfflineResolutions,
} from 'tsdf';
```

Each store also exposes scoped APIs:

- `getOfflineEntities()` / `useOfflineEntities()`
- `getOfflineResolutions()` / `useOfflineResolutions()`
- `resolveOfflineResolution(...)`
- `parseOfflineResolutionConflict(...)`

List-query stores additionally expose `usePendingOfflineItems(...)`, which returns pending creates/updates and pending deletes without mounting or fetching a query.

## Runtime Controls

The store manager owns runtime controls for the shared session:

```ts
storeManager.setOfflineRuntimeConfig({ network: { enabled: false } });

storeManager.resetOfflineRuntimeConfig();
```

`getOfflineRuntimeConfig()` returns the current effective controls. Runtime updates are useful for explicit "work offline" toggles, diagnostics, or temporarily disabling queueing modes.

### Forced offline mode

`setForcedOfflineMode(forced)` makes the session behave as if the network were down, without cutting the real connection:

```ts
const result = await storeManager.setForcedOfflineMode(true);

storeManager.getOfflineStatus().isForcedOffline; // true

await storeManager.setForcedOfflineMode(false);
```

- While forced, the session's network detection reports offline regardless of `navigator.onLine` / `network.getIsOffline`: fetches are served from cache, offline-enabled mutations are queued, and neither replay nor recovery checks run. Successful requests and browser `online` events cannot end it.
- The flag is persisted per session key in `localStorage` and read synchronously when the session boots, so it survives reloads and the first fetches after a reload are already offline. It stays on until it is turned off.
- It is shared with the other tabs of the same session: open tabs follow the toggle, tabs opened later boot with it.
- Turning it off hands control back to the real network detection. If the network is up, the session recovers and replays queued work exactly like a normal reconnect; if it is really down, the session stays offline.
- It is a simulated network loss, so it requires `offlineSession.network` and only takes effect while network mode is enabled. The call resolves to `Result.err(...)` when `offlineSession.network` is not configured or there is no active session key.
- The returned promise resolves once the flag is persisted, so it is safe to reload right after awaiting it.

Unlike `setOfflineRuntimeConfig(...)`, which is in-memory and changes which modes are allowed, forced offline mode is persisted and changes what the session detects. It is a runtime control available in production builds, meant for manual testing, end-to-end tests and support diagnostics. Expose it deliberately (e.g. a dev tools panel), and show `isForcedOffline` in the UI when you do, since the app will keep booting offline until it is released.

## Testing

### End-to-end tests

Browser automation tools can cut the connection (e.g. Playwright's `context.setOffline(true)`), but that also blocks loading the app itself on the next navigation unless a service worker serves it. Forced offline mode keeps the real network up and only takes the offline session offline, and it survives the reload:

```ts
// `storeManager` exposed by the app for tests, e.g. on `window`
await page.evaluate(() => window.storeManager.setForcedOfflineMode(true));
await page.reload();

// ...the app boots offline from cache; edits are queued

await page.evaluate(() => window.storeManager.setForcedOfflineMode(false));
// ...queued edits are replayed
```

When several pages of the same session are open, replay is done by the leading tab (the visible, most recently focused one), which replays the edits it queued itself or loaded from storage when it booted, same as for a real reconnect. In a multi-page test, queue the edits from the page that was opened or focused last.

### Unit and component tests

`tsdf/testing` exports a network status mock with no dependency on a test runner:

```ts
import { createOfflineNetworkMock } from 'tsdf/testing';

const network = createOfflineNetworkMock();

beforeEach(() => network.install());
afterEach(() => network.uninstall());

test('queues the edit while offline', async () => {
  network.goOffline();
  // ...perform the mutation, assert it was queued

  network.goOnline();
  // ...assert it was replayed
});
```

- `install()` / `uninstall()` replace and restore `navigator.onLine` (requires a DOM environment such as `happy-dom` or `jsdom`). That is enough for sessions using the default detection.
- `network.config` is a ready-to-use `offlineSession.network` value (`{ enabled: true, getIsOffline }`) for sessions that should read the mock directly.
- `goOffline()` / `goOnline()` change the status and dispatch the window `offline` / `online` events, like the browser does. `setOffline()` / `setOnline()` change it silently, e.g. to prepare the status before the app boots.
- `isOnline()` / `isOffline()` read the mocked status.

## Uploads

Configure uploads on `offlineSession.uploads` when queued mutations depend on local files. The manager exposes upload helpers:

- `saveOfflineUpload({ id, file })`
- `replaceOfflineUpload({ id, file })`
- `loadOfflineUpload(id)`
- `deleteOfflineUpload(id)`
- `resolveOfflineUpload(id)`
- `resolveOfflineUploads(ids)`
- `useOfflineUploads()`

Operations can declare `dependsOnUploads({ input })` and then read resolved upload refs from `execute({ uploads })`. `opfsOfflineUploadAdapter` is exported as a built-in OPFS-backed upload adapter.
