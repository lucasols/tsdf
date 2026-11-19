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

A mutation is also queued while online when older mutations for the same entities (the operation's `getEntityRefs`) are still waiting in the queue, for example right after reconnecting while the replay is in flight. Sent on its own it would reach the server before them and then be overwritten, so it joins the queue and is replayed in the order the user made the changes.

Without an active offline session — `getSessionKey()` returns `false`, or the [session gate](#session-gate) is closed — the same call runs as a plain online mutation: `mutation` is called, a success resolves with `{ kind: 'online', data }`, and a failure goes through the normal error handling (optimistic update rolled back, `onMutationError` called). Nothing is queued.

## Health Check

The session is in offline mode for one of two causes: `network` (this device cannot reach the backend) or `outage` (the backend is reached but down). Browser `online` / `offline` events only cover part of the first one. For everything else the app usually has one health endpoint that answers both "this request failed: is it the network, an outage, or just this request?" and "are we back?". Wire it once with `offlineSession.healthCheck`:

```ts
const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  errorNormalizer: normalizeError,
  offlineSession: {
    network: { enabled: true },
    outage: { enabled: true },
    healthCheck: {
      check: async ({ signal }) => {
        try {
          const response = await fetch('/api/health', { signal });
          return response.ok ? 'up' : 'outage';
        } catch {
          return 'unreachable';
        }
      },
    },
  },
});
```

`check(ctx)` receives `{ sessionKey, signal }` and returns (or resolves to) one of:

| Answer          | Meaning                                        | As a failure classification | As a recovery check             |
| --------------- | ---------------------------------------------- | --------------------------- | ------------------------------- |
| `'up'`          | The backend answered and is healthy            | The session stays online    | Offline mode ends               |
| `'outage'`      | The backend was reached but is down            | Outage mode becomes active  | Outage mode (stays or replaces) |
| `'unreachable'` | The backend cannot be reached from this device | Network mode becomes active | Network mode (stays or returns) |

The session uses the same function in both places:

- **Failure classification.** When a fetch, a mutation or the replay of a queued mutation fails, the session runs the check and applies the answer.
- **Recovery checks.** While a mode is active because of a failure, its recovery probe runs the check on that mode's `recoveryProbe` cadence (network: 5s growing to 60s, outage: 30s growing to 5min by default). `'up'` ends the offline mode — both causes at once when both are active. `'outage'` during network mode means the device reaches the backend again but the backend is down: outage mode takes over. `'unreachable'` during outage mode activates network mode and keeps the outage, since nothing can be said about it until the backend is reachable. With a health check, `outage.recoveryCheck` is optional.

In both places an answer only activates a mode that is enabled (`network.enabled` / `outage.enabled`, including runtime overrides). An answer for a disabled mode is ignored: a failed request is left to its own error.

### `'up'` means the failure belongs to the request

When the check answers `'up'` for a failed request, the session stays online and that request's own failure handling applies, even if the endpoint it called is down. For example, an upload endpoint answering 503 while the API health check passes:

- a fetch or a direct mutation fails with its own error;
- a queued mutation being replayed goes through `classifyRetryableFailure` and the `replayRetry` budget, and ends in a `retry-exhausted` resolution (see [Conflict Resolution](#conflict-resolution)).

If the session should pause for that service instead, make `check` cover it (answer `'outage'` when it is down) or return `'outage'` for its failures from `classifyFailure`.

### One request for many failures

While a check is in flight, every failure and recovery tick that needs an answer waits for that same call: a burst of requests failing right when the backend goes down costs one health request. Failures that arrive while the session is already in offline mode do not run the check at all — the active mode explains them, and asking "are we back?" is the job of the recovery checks.

A finished answer is never reused. A cached `'up'` could hide an outage that started right after it, so the next failure after a check has settled starts a new one. The check is never called on the success path.

### With `classifyFailure` and `recoveryCheck`

The health check is the fallback; the more specific hooks win:

- `classifyFailure(error, ctx)` runs first. `'outage'`, `'network'` and `'ignore'` are final answers and the health check is not called for that failure. Return `'unknown'` when the error alone does not tell, to ask the health check. This keeps obvious request errors (validation, 404) from costing a health request:

  ```ts
  classifyFailure: (error) => (isClientError(error) ? 'ignore' : 'unknown'),
  ```

  Without `classifyFailure`, every failure asks the health check.

- A mode with its own `recoveryCheck` (`network.recoveryCheck` / `outage.recoveryCheck`) keeps using it for its recovery; the health check is the recovery check of the modes that do not have one.

### When the check gives no answer

A check that throws, rejects, or takes longer than `healthCheck.timeoutMs` (default 10s) gives no answer and changes nothing: a failure being classified is left to its request, and a recovery check counts as "not recovered yet" and is retried on the normal cadence. `ctx.signal` is aborted on timeout so the health request can be cancelled. No answer is never read as `'unreachable'`: a broken or slow health endpoint is not evidence about connectivity, and the browser going offline is already detected by network mode. Return `'unreachable'` from `check` when the request itself fails, as in the example above.

The check is not called while the [session gate](#session-gate) is closed, or while both modes are disabled and neither is still active.

## Revalidation After Recovering

While the session is in offline mode, automatic revalidations that could only fail are held: `onTransportReconnect()` signals and window-focus revalidations are ignored, and cached data stays visible.

Each store attached to the manager revalidates by itself once it recovers, without the app having to invalidate anything:

- the session left offline mode, and
- its queued mutations finished replaying (data fetched earlier could predate them), and
- the store has no entity left waiting for a manual resolution (a refetch would replace the local changes the user still has to decide on; resolving or discarding them triggers the revalidation).

Mounted data refetches right away, unmounted data on its next mount. Stores with `usesRealTimeUpdates` revalidate with `realtimeUpdate` priority, other stores with `highPriority`. Tabs that are not focused revalidate when they get focus. Items that only exist locally (offline creations not sent yet) are skipped by invalidations, since there is nothing to fetch for them.

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

- `discard` - Drop the resolution record. The optimistic changes of the discarded mutation cannot be rolled back locally, so TSDF refetches what the operation referenced (`getEntityRefs`): the document, the collection item, or the list query item together with the store's lists (the change may have moved or removed the row). Discarding a temp create removes the temp entity and everything queued on top of it.
- `requeue` - Queue replacement input for an operation conflict.
- `commit` - Accept an externally completed resolution result.
- `retry` - Retry a retry-exhausted record.

A mutation that exhausted its replay retries leaves the queue when it becomes a resolution record, so the mutations queued behind it keep replaying; only the ones that depend on it (queued on top of its temp entity) wait with it.

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

Disabling a mode only stops new work from entering it: an offline state that is already active is preserved so the work depending on it can still recover and replay. To turn the whole offline layer off, use the session gate instead.

### Session gate

`offlineSession.enabled` turns the whole offline layer on and off at runtime — for a feature flag or a per-workspace setting — without recreating the store manager or its stores:

```ts
const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  errorNormalizer: normalizeError,
  offlineSession: {
    enabled: () => featureFlags.offlineMode,
    network: { enabled: true },
  },
});
```

While it returns `false` the session behaves as if no offline session existed:

- it never enters offline mode: network detection is ignored and neither `classifyFailure` nor `healthCheck` is called. The offline status reports `isOfflineMode: false`, and `getOfflineRuntimeConfig()` reports both modes as not enabled
- fetches always go to the network and fail with their normal errors
- mutations with an `offline` descriptor run as plain online mutations (see [Queuing Mutations](#queuing-mutations))

Mutations already queued when the gate closes are neither deleted nor replayed. They stay in persistent storage untouched, still listed by the offline entities / resolutions APIs, and are replayed once the gate reopens and the session is online. A queued mutation whose replay request fails because the gate closed mid-flight goes back to the queue as pending. Mutations made while the gate is closed go straight to the server, so they are not ordered after older mutations still waiting in the queue for the same entities: when that matters, close the gate only once the offline entities list is empty.

The callback is read before every fetch and mutation, on browser `online` / `offline` events and before each queued mutation is replayed, so it must be synchronous and cheap (read a variable or a store, no I/O). The app does not have to call anything for a flip to apply to the next fetch or mutation. To apply it right away — clear the offline status in the UI as soon as the gate closes, or start replaying the queue as soon as it reopens on an idle screen — call `storeManager.setOfflineRuntimeConfig({})` after changing the value: every runtime config update re-reads the gate. Runtime overrides and the upload helpers are not affected by the gate.

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
