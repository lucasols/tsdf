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

A mutation is also queued while online when older mutations for the same entities (the operation's `getEntityRefs`) or for the entities it depends on (`dependsOn`), or queued mutations that depend on an entity it changes (e.g. a queued subfolder creation and a delete of its folder), are still waiting in the queue, for example right after reconnecting while the replay is in flight. Sent on its own it would reach the server before them (and be overwritten, or reference an entity the server does not have yet), so it joins the queue and is replayed in the order the user made the changes.

Queued mutations and pending resolutions are persisted through the store's own `persistentStorage.adapter`, and the cached entries they reference are protected from cache expiry until the queue is replayed or discarded. They are not migrated when a store's adapter changes: let the queue drain first. See [Changing a store's adapter](./persistent-storage.md#changing-a-stores-adapter).

The mutation promise resolves only after the queue write has settled, so a mutation is never reported as queued while its write is still in flight. If the storage adapter cannot write the queue at all (for example the browser lost its IndexedDB connection and a new one cannot be opened), the failure is reported through `onPersistentStorageError`, but the result is still `{ kind: 'queued' }`: the mutation stays queued in memory, its optimistic state stays visible, and it is replayed if the session recovers in the same page load. It is not on disk, so it is lost if the page is reloaded first. Treat an `onPersistentStorageError` call while offline as "pending changes may not survive a reload".

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
- **Recovery checks.** While a mode is active because of a failure, its recovery probe runs the check on that mode's `recoveryProbe` cadence (network: 5s growing to 60s, outage: 30s growing to 5min by default). `'up'` ends the offline mode — both causes at once when both are active. `'outage'` during network mode means the device reaches the backend again but the backend is down: outage mode takes over, or, when outage mode is disabled, network mode just ends and requests (including the replay of queued mutations) fail with their own errors. `'unreachable'` during outage mode activates network mode and keeps the outage, since nothing can be said about it until the backend is reachable. With a health check, `outage.recoveryCheck` is optional.

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

## Reading While Offline

While the session is in offline mode, fetches are not sent to the server. What a document, item or query reports depends on whether it has data to return:

- **Cached data** (loaded earlier, or restored from persistent storage): the cached data stays visible with `status: 'success'` and `error: null`. A refetch attempted offline leaves it that way, so there is no offline error to hide in the UI.
- **Nothing cached**: the read fails with `status: 'error'` and the offline error `{ code: 0, id: 'offline', message: 'Offline' }`. This is the only offline state the app has to explain to the user.

Use `isOfflineStoreError(error)` to recognise that error instead of comparing `error.id` by hand. It matches the whole error shape, so an app error whose `errorNormalizer` also uses the `'offline'` id is not mistaken for it, and it narrows the error to the exported `OfflineStoreError` type:

```tsx
import { isOfflineStoreError } from 'tsdf';

function UserName({ id }: { id: number }) {
  const { data, error, isLoading } = userStore.useItem({ id });

  if (isLoading) return <Spinner />;
  if (isOfflineStoreError(error)) return <NotAvailableOffline />;
  if (error) return <ErrorMessage error={error} />;

  return <span>{data?.name}</span>;
}
```

It also accepts the `StoreFetchError` returned by the `awaitFetch` methods, which resolve with the cached data while offline and with the offline error only when nothing is cached.

With [partial resources](./partial-resources.md), "cached" is decided per hook, by the `fields` it requests:

- A hook whose requested fields are all cached is a cached read: `status: 'success'`, `error: null`. Fields that were loaded and later invalidated count as cached — they stay visible and are refreshed after recovering.
- A hook requesting fields that were never loaded has nothing usable to return for them, so it reports `status: 'error'` with the offline error, without attempting a fetch. Its data stays hidden as it would be while loading (`data: null`, `items: []`), or stays visible with `loadingFields` when `showPartialAsRefetching` is enabled.

Both can be mounted for the same item or query at the same time: the hook waiting for missing fields does not disturb the one reading cached fields.

A cached list query that lost a row before one of the rows that are left (or every row) is not a cached read: it is not reported as a complete `success`. A list that only lost its last rows (e.g. to `maxItemBytes`) is still a cached read, with fewer rows. Hooks return the rows that are left with `status: 'error'` and the offline error (`isOfflineStoreError(error)`), so the screen can show them together with a notice that the list is incomplete. See [Cached list queries that lost rows](./persistent-storage.md#cached-list-queries-that-lost-rows).

Both kinds of reads are refetched once the session recovers (see below): reads that failed offline load, and cached reads get refreshed.

## Revalidation After Recovering

While the session is in offline mode, automatic revalidations that could only fail are held: `onTransportReconnect()` signals and window-focus revalidations only re-check connectivity (`network.getIsOffline`) instead of refetching, and cached data stays visible. When the re-check finds the connection back, the session leaves offline mode and the stores revalidate as described below.

Each store attached to the manager revalidates by itself once it recovers, without the app having to invalidate anything:

- the session left offline mode, and
- its queued mutations finished replaying (data fetched earlier could predate them), and
- the store has no change left waiting for a manual resolution (a refetch would replace the local changes the user still has to decide on; resolving or discarding them triggers the revalidation).

Mounted data refetches right away, unmounted data on its next mount. Stores with `usesRealTimeUpdates` revalidate with `realtimeUpdate` priority, other stores with `highPriority`. Stores with `usesRealTimeUpdates` first wait one `transportReconnectCooldownMs` (2s by default): the app's transport usually reconnects right after the network comes back, and the `onTransportReconnect()` call in that window runs a single revalidation for both. Without a reconnect, the store revalidates when the cooldown ends, or right away when discarding a change refetches the store in the meantime. Tabs that are not focused revalidate when they get focus. Items that only exist locally (offline creations not sent yet) are skipped by invalidations, since there is nothing to fetch for them.

## Operation Definitions

All offline operations define:

- `inputSchema` - Validates mutation input before it enters the queue and again when restored.
- `kind` - `create`, `update`, or `delete`; TSDF derives each affected entity's lifecycle from this. Every item a `create` returns from `getEntityRefs` is treated as created by it (discarding a `create` without temp entity removes all of them), so return only the created items: change existing items in a separate `update` operation, and reference the items the creation needs with `dependsOn`.
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

Queued mutations and resolutions whose operation the running deploy doesn't define (for example ones queued by a newer deploy in another tab) stay in storage, together with their uploads, but that deploy neither lists nor replays them. A deploy that defines the operation picks them up and sends or resolves them. Apps are expected to reload tabs running an old deploy: TSDF doesn't coordinate the order of offline work between deploys, so an old tab can send its own edits around the work it keeps. Records of an operation removed from the app for good also stay in storage until the session's storage is cleared (`clearSessionStorage`), so keep an operation defined until its queued work is likely gone.

Create flows for collection and list-query stores can use `tempEntity` or `tempEntities` to insert optimistic entities with temporary payloads and reconcile them to final server payloads after replay. Document stores do not support temp entities.

### Temp Entities in List Queries

In a list-query store the pending entity is inserted as an item only, so it is not part of any list unless `optimisticListUpdates` rules match it. Declare `addToQueries` to add it to the lists that should show it while the mutation is queued:

```ts
createUser: {
  inputSchema: createUserInputSchema,
  kind: 'create',
  getEntityRefs: ({ input }) => [`temp:${input.clientId}`],
  tempEntity: {
    buildPendingEntity: (input) => ({ id: input.clientId, name: input.name }),
    // Same shape as the `addItemToQueries` option of `addItemToState`,
    // or a function of the mutation input that returns it
    addToQueries: (input) => ({
      queries: { teamId: input.teamId },
      appendTo: 'start',
    }),
    reconcileServerEntity: (result) => ({
      finalPayload: result.id,
      finalData: result,
    }),
  },
  execute: ({ input }) => api.createUser(input),
},
```

- The entity is added to the queries when the mutation is queued, so `optimisticUpdate` does not need to call `addItemToState` for it. A mutation that runs online right away is never queued and creates no pending entity.
- `queries` follows `addItemToState`, except that queries saved in persistent storage but not loaded yet (after a restart, before a screen reads them) are loaded first, so the row also reaches them. A filter function only matches the queries the app session already knows, so prefer query payloads.
- The membership is stored with the queries, so the row is still in its lists after the app restarts with the mutation queued.
- When replay succeeds, the final server entity takes the place of the temp one in every query that still contains it. The declared queries that are only in persistent storage are loaded first: the function form of `addToQueries` runs again for this, so it should only depend on its arguments. Discarding the queued mutation removes the row from its lists.
- While the mutation is pending, a list refetch that does not return the row keeps it rendered at its last known position. This memory does not survive an app restart.

With `tempEntities`, each entry returned by `buildPendingEntities` declares its own `addToQueries`. The builder does not run again at replay, so a declared query that is only in persistent storage when the mutation is replayed gets the final entities on its next fetch.

With [partial resources](./partial-resources.md), the pending entity has no loaded-fields metadata, so only `inferFields` can vouch for it. Declare `loadedFields` (for example `'*'`) when the pending entity should count as loaded for hooks that read those fields: it cannot be fetched from the server before the mutation is replayed. The entity keeps the same loaded fields when it is reconciled to its final payload, so a `finalData` returned by the reconcile hook must hold at least those fields; omit `finalData` to keep the pending entity's data instead.

```ts
tempEntity: {
  buildPendingEntity: (input) => ({ id: input.clientId, name: input.name }),
  addToQueries: { queries: { teamId: 'team-1' }, appendTo: 'start' },
  loadedFields: '*',
  // ...
},
```

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

- `discard` - Drop the resolution record. The optimistic changes of the discarded mutation cannot be rolled back locally, so TSDF refetches what the operation referenced (`getEntityRefs`): the document, the collection item, or the list query item together with the store's lists (the change may have moved or removed the row). An entity that other changes still wait for a decision on is not refetched, since the refetch would replace those changes: it is revalidated once the last one is handled. Likewise, while other changes of a list query store still wait for a manual resolution, only the item is refetched: its lists are revalidated once the last one is handled. Discarding a temp create removes the temp entity and everything queued on top of it; existing entities changed on top of it are refetched. Discarding a `create` without temp entity (the app generated the id on the client) removes the items it created (its `getEntityRefs`) from the store, its lists and the persisted cache, like a temp entity, instead of refetching them: a discarded creation is treated as never sent. If the server did create one (the response of an earlier replay attempt was lost, or a conflict reported that it already exists), it stays removed locally until something fetches it again: the recovery revalidation of a list query store's lists brings it back (right away when no other change waits for a decision, otherwise once the last one is handled), but a collection item, or a list query item outside every loaded list, shows `deleted` until it is fetched again, e.g. after a reload. Discarding a temp create has the same tradeoff. Unlike changes made on top of a temp entity, changes queued on such an item are not held behind its failed creation: they are sent on their own and need their own decision if the server rejects them. Until they are sent, their optimistic view keeps the item visible in its views, even though the discard removed it from the store.
- `requeue` - Queue replacement input for an operation conflict.
- `commit` - Accept an externally completed resolution result.
- `retry` - Retry a retry-exhausted record.

A mutation that exhausted its replay retries leaves the queue when it becomes a resolution record, so the mutations queued behind it keep replaying; only the ones that depend on it (queued on top of its temp entity) wait with it.

Use `parseOfflineResolutionConflict(resolution)` to narrow a persisted resolution back to the operation-specific conflict/input type before rendering a manual resolution UI.

### Resolving From A Session-Wide UI

An app-wide "sync problems" panel that lists `storeManager.useOfflineResolutions()` does not need to import every store to offer Retry / Discard. The manager applies the generic actions to any resolution of the session by finding the store that owns it:

```tsx
function SyncProblems() {
  const resolutions = storeManager.useOfflineResolutions();

  async function resolve(id: string, action: 'retry' | 'discard') {
    const result = await storeManager.resolveOfflineResolution(id, action);
    if (!result.ok) showToast(result.error.message);
  }

  return resolutions.map((resolution) => {
    const isBlocked = resolution.blockedResolutionCount > 0;

    return (
      <SyncProblemRow
        key={resolution.id}
        resolution={resolution}
        canRetry={resolution.kind === 'retry-exhausted' && !isBlocked}
        canDiscard={!isBlocked}
        onRetry={() => resolve(resolution.id, 'retry')}
        onDiscard={() => resolve(resolution.id, 'discard')}
      />
    );
  });
}
```

The behavior is the same as calling the owning store's `resolveOfflineResolution(id, operation, { action })`, including retrying retryable descendants and discarding dependents. Only `retry` and `discard` are available here; `requeue` and `commit` need operation-typed input and stay on the store API.

Failures are returned as a `Result` instead of thrown. `result.error` is an `OfflineResolutionActionError` with the `resolutionId`, the owning `storeName` (when known), and a `code`:

| `code`                   | Meaning                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resolution-not-found`   | No resolution with this id in the active session, e.g. it was already resolved (possibly from another tab) or the session is logged out.                                             |
| `store-not-registered`   | The owning store was not created with this manager (yet). Resolutions are shared by the whole session, including other tabs, so a record can be listed before its store exists here. |
| `retry-not-supported`    | `retry` was requested for a `conflict` record. Conflicts are resolved with `discard`, or with `requeue` / `commit` on the store API.                                                 |
| `resolution-blocked`     | The record is blocked by parent resolutions (`blockedByResolutionIds`). Resolve the parents first.                                                                                   |
| `offline-not-configured` | The manager was created without `offlineSession`.                                                                                                                                    |
| `action-failed`          | The owning store failed while applying the action. The original error is in `error.cause`.                                                                                           |

## Reading Offline State

Use manager-level APIs for session-wide UI:

```tsx
const status = storeManager.useOfflineStatus();
const entities = storeManager.useOfflineEntities();
const resolutions = storeManager.useOfflineResolutions();
```

`storeManager.resolveOfflineResolution(id, 'retry' | 'discard')` acts on any of those resolutions without the owning store instance (see [Resolving From A Session-Wide UI](#resolving-from-a-session-wide-ui)).

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

### Per-item state

Collection and list-query stores expose `useItemOfflineState(itemPayload)` / `getItemOfflineState(itemPayload)` for per-row UI such as sync badges. They return `null` when the item has nothing queued, otherwise `{ syncState, pendingMutations, requiresResolution, isUnsentCreation }`:

```tsx
const offlineState = userStore.useItemOfflineState({ id: 1 });
// null | { syncState: 'pending', pendingMutations: 1, requiresResolution: false, isUnsentCreation: false }
```

Prefer it over building a map from `useOfflineEntities()`: a component using the hook re-renders only when the state of its own item changes. `isUnsentCreation` is `true` for an item created offline until the server confirms it; after that the temporary payload returns `null` and the final payload reports the mutations still queued for the item. See [Hooks - useItemOfflineState](./hooks.md#useitemofflinestate).

Document stores hold a single entity, so they do not need a per-item reader: use `useDocument().pendingSync` or `useOfflineEntities()[0]`.

## Multiple Tabs

Tabs of the same session share one offline queue. Every tab can queue mutations and every tab shows the same pending state, but only one tab sends the queued work:

- The **leading tab** replays the queue: the visible tab, or the one that was visible most recently. `useOfflineStatus().isLeader` tells whether the current tab leads.
- A mutation queued in any other tab is sent by the leading tab after the connection recovers, in the order the mutations were queued across tabs. No reload or tab switch is needed.
- Every queued mutation is sent once. A cross-tab lock (Web Locks API) keeps two tabs from replaying a store's queue at the same time, and a tab drops an entry as soon as another tab reports it as sent, so it does not send it again when it leads later. Where the Web Locks API is unavailable (pages served over plain `http` other than `localhost`), this guarantee does not hold and TSDF logs a warning. It also only holds between tabs running the same app version (`getAppVersion`) and the same TSDF release: tabs on different versions do not see each other's messages, so after a deploy an old tab and a new tab can both send the same queued mutation.
- When the leading tab sends a temp-entity creation queued in another tab, every tab with the store emits `tempEntityReconciled`, so a view that follows the temp id can switch to the final one in any tab.
- When the leading tab is closed or hidden, a visible tab takes over. When the previous tab was replaying or just did, the new one first waits for the mutation that tab is sending to finish, then up to a second more, so it learns what that tab already sent before it starts.

Things to keep in mind:

- A tab can only replay the operations of stores it has created. Create the stores of a session in every tab (the usual module-level setup) so the leading tab can replay all of them.
- `accumulation` only merges into mutations queued in the same tab. Mutations queued in different tabs are sent as separate requests.
- Leadership follows visibility. If every remaining tab is hidden, queued work waits until one of them becomes visible.
- While offline, each tab shows its own optimistic changes. Tabs converge once the queue is replayed and the data is fetched again.
- Tabs coordinate through browser messages, which cannot give a strict guarantee when a tab is closed or frozen in the middle of a hand-off. For mutations that must never run twice (for example payments), also make the server endpoint idempotent.

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

The callback is read before every fetch and every mutation with an `offline` descriptor, on browser `online` / `offline` events, before each recovery check and before each queued mutation is replayed, so it must be synchronous and cheap (read a variable or a store, no I/O). The app does not have to call anything for a flip to apply to the next fetch or mutation. To apply it right away — clear the offline status in the UI as soon as the gate closes, or start replaying the queue as soon as it reopens on an idle screen — call `storeManager.setOfflineRuntimeConfig({})` after changing the value: every runtime config update re-reads the gate. Runtime overrides and the upload helpers are not affected by the gate.

The tabs of a session key share its offline status and its replay, so `enabled()` must return the same value in every tab of that session key. A tab with the gate closed would clear an offline mode another tab still relies on, and a leading tab with the gate closed holds back the replay of every tab. To gate per workspace, include the workspace in the session key.

## Uploads

Configure uploads on `offlineSession.uploads` when queued mutations depend on local files. The manager exposes upload helpers:

- `saveOfflineUpload({ id, file, metadata? })`
- `replaceOfflineUpload({ id, file, metadata? })`
- `loadOfflineUpload(id)`
- `deleteOfflineUpload(id)`
- `resolveOfflineUpload(id)`
- `resolveOfflineUploads(ids)`
- `useOfflineUploads()`

Operations can declare `dependsOnUploads({ input })` and then read resolved upload refs from `execute({ uploads })`. When queued mutations are merged (`accumulation.mergeInput`), the dependencies are computed again from the merged input, so files referenced by any of the merged edits are uploaded before `execute` runs. `opfsOfflineUploadAdapter` is exported as a built-in OPFS-backed upload adapter.

### Upload metadata

The session has a single `upload` transport, so uploads that need different request parameters (target kind, parent ids, ...) carry them as `metadata` instead of encoding them in the upload id:

```ts
const uploadMetadataSchema = rc_discriminated_union('kind', {
  chat: { chatId: rc_string },
  record: { tableId: rc_string },
});

const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  errorNormalizer: normalizeError,
  offlineSession: {
    uploads: {
      adapter: opfsOfflineUploadAdapter,
      upload: ({ file, metadata, onProgress }) => {
        // Uploads staged without metadata (direct mutation uploads, uploads
        // saved by older versions) use the default request.
        if (metadata === undefined) return uploadFile(file, onProgress);

        // Restored from storage: validate before use.
        const target = rc_parse(metadata, uploadMetadataSchema).unwrap();

        return target.kind === 'chat'
          ? uploadChatFile(target.chatId, file, onProgress)
          : uploadRecordFile(target.tableId, file, onProgress);
      },
    },
  },
});

await storeManager.saveOfflineUpload({
  id: attachmentId,
  file,
  metadata: { kind: 'chat', chatId },
});
```

- `metadata` is optional and must be a JSON-serializable `ValidPayload` (`string`, `number`, or a plain object).
- It is persisted with the upload record, so it survives reloads, is passed to the `upload` transport both on replay and on `resolveOfflineUpload(s)`, and is exposed as `metadata` on the `OfflineUpload` entries returned by `getOfflineUploads()` / `useOfflineUploads()`.
- Because it is read back from storage, it is typed as an unvalidated `ValidPayload`: parse it with a schema before using it, as above. Uploads staged without metadata reach the transport with `metadata: undefined`, so handle that case explicitly. This includes the ones persisted by older versions and files attached directly to a mutation with its `upload` option, which can't carry metadata.
- `saveOfflineUpload` stores exactly the metadata it receives. `replaceOfflineUpload` keeps the metadata already saved for that id unless new `metadata` is passed. Both fail while that upload is queued or being sent.
- Custom `OfflineUploadAdapter` implementations must persist and restore the record's `metadata` and `storeName` fields together with the rest of the record. `storeName` marks which store queued a file attached to a mutation. That file is removed once nothing in that store's queue uses it, and only while that store is created in the tab, so a store created later (for example on a code-split screen) still finds its files.

### Upload lifecycle

A staged upload follows the queued work that depends on it:

- While a queue entry or resolution record declares the upload through `dependsOnUploads`, the upload is kept. This includes a failed mutation waiting for a manual resolution, so `retry` still finds the file. `deleteOfflineUpload(id)` returns an error for an upload in this state.
- When the last queue entry or resolution record that declares it leaves the queue, TSDF deletes the upload (its record and the stored file). It does not matter how the work ended:
  - it replayed successfully, or `shouldSkipSync` dropped it;
  - its resolution was discarded, together with the queued work discarded with it (the edits of an entity whose create was discarded);
  - a later operation pruned it with `supersedes`, or cancelled it with its temp entity (`dropSelfIfTempLifecycleCancelled`);
  - its conflict was resolved with `commit`, or with a `requeue` whose replacement input no longer declares the upload. Uploads the replacement input still declares are kept.
- References are session-wide. An upload declared by queued mutations of several stores is deleted only after the last of them is gone. Only stores created in the tab count: an upload staged with `saveOfflineUpload` and shared with a store that is not created in the tab yet (a code-split screen, or the app restarted on another screen) can be deleted when the stores already created release it, and that store's queued mutation then fails to replay. If an upload id is shared across lazily created stores, create those stores before their queued work replays, or stage a separate upload for each store. Files attached directly to a mutation don't have this limit: they record the store that queued them (see `storeName` above).
- An upload that no queued work declared yet is never deleted for being unreferenced: the app stages the file first and queues the mutation afterwards. It stays until a mutation that declares it is queued and leaves the queue, until the app calls `deleteOfflineUpload(id)`, or until it expires. Unreferenced uploads expire after the session has been online for one week without interruption (going offline restarts the window). This also applies to uploads the app resolves itself with `resolveOfflineUpload(s)` for an online mutation, because they never enter the queue.

After an upload that was already sent is deleted, its id keeps resolving to the same server ref for the rest of the app session, in every tab open when it was deleted: a mutation queued later that still declares it (for example from optimistic or draft data that was not updated with the server ref yet) replays with that ref without uploading again, and `resolveOfflineUpload(id)` returns it. This ref is kept in memory only: after a reload, in a tab opened later, or after `deleteOfflineUpload(id)`, the id is unknown again, so stage the file again with `saveOfflineUpload` before reusing it. Uploads deleted before they were sent (discarded, superseded or cancelled work) are not kept.

Files attached directly to a mutation (`upload: { ... }` in `performMutation`) belong to that single queued mutation and are deleted with it in the same situations.

### Upload failure handling

The `upload` transport reports a failure by rejecting (throwing). What happens next depends on who started the upload.

#### Dependency uploads during replay

When a queued operation with `dependsOnUploads` replays, a transport failure is classified by the same session hooks as a failed `execute`: `classifyFailure(error, ctx)` and then `classifyRetryableFailure(error, ctx)`. `ctx` is the context of the operation being replayed (`phase: 'sync'`, `storeType`, `operationName`, `sessionKey`) plus `uploadId`, the id of the upload that failed. `execute` is not called for that attempt. Other failures while resolving that upload, such as a storage error reading the staged file, are classified the same way with `uploadId` set, so check the error type instead of assuming every failure with `uploadId` came from the transport.

- **Connection problem or outage** - `classifyFailure` returns `'network'` or `'outage'` (and that mode is enabled, as for any other failure). The session enters that mode, the upload goes back to `pending` (with `lastError` set) and the operation stays queued. Replay runs the upload again when the session recovers. The replay retry budget is not consumed, however long the outage lasts.
- **Transient failure that is safe to repeat** - `classifyFailure` returns `'ignore'` and `classifyRetryableFailure` returns `true`. The upload goes back to `pending` and is sent again on the `replayRetry` cadence (`intervalMs`, 5s by default). After `maxFailures` attempts (3 by default) it is handled as a permanent failure.
- **Permanent failure** (file too large, type not accepted) - no hook recognizes the error, which is the default. The upload becomes `failed` and the operation moves right away to a `retry-exhausted` resolution: `lastReplayError` carries the upload error and `dependencyUploadIds` lists the uploads it depends on. Resolving it with `retry` requeues the operation, which runs the upload again; `discard` removes the operation and, when no other queued work declares the upload, deletes the staged file (see "Upload lifecycle").

`lastError` is cleared when an upload succeeds.

The hooks are the only way to tell these cases apart, so the transport must throw errors they can recognize:

```ts
class UploadError extends Error {
  kind: 'connection' | 'server-down' | 'rejected';

  constructor(kind: UploadError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  errorNormalizer: normalizeError,
  offlineSession: {
    network: { enabled: true, recoveryCheck: pingApi },
    outage: { enabled: true, recoveryCheck: pingApi },
    classifyFailure: (error) => {
      if (error instanceof UploadError) {
        if (error.kind === 'connection') return 'network';
        if (error.kind === 'server-down') return 'outage';
        return 'ignore'; // rejected file: manual resolution
      }

      return classifyApiError(error);
    },
    uploads: {
      adapter: opfsOfflineUploadAdapter,
      // Throws `UploadError` with the kind that matches what went wrong.
      upload: ({ file, onProgress }) => uploadFile(file, onProgress),
    },
  },
});
```

Check `ctx.uploadId !== undefined` when a classifier needs to treat upload failures differently from `execute` failures that throw the same error type.

#### `resolveOfflineUpload(s)`

When the app uploads a staged file itself, a transport failure is returned to the caller as `Result.err(error)` and the upload becomes `failed` with `lastError` set. The session hooks are not consulted, the session mode does not change, and nothing is retried automatically: the caller decides what to do, and calling `resolveOfflineUpload(s)` again runs the upload again.

#### Upload states

- `pending` - staged and waiting to be uploaded, including uploads waiting for an automatic retry (those have `lastError` set).
- `uploading` - the transport is running.
- `uploaded` - the transport returned the final ref (`resolvedRef`).
- `failed` - the last attempt failed and TSDF will not retry on its own. A `failed` upload is never blocked: it is uploaded again the next time an operation that depends on it is replayed or `resolveOfflineUpload(s)` is called for it.

Queued mutations and staged uploads live in browser storage (localStorage, IndexedDB, OPFS), which the browser may evict under storage pressure unless the origin was granted persistent storage. TSDF does not request it: `navigator.storage.persist()` is an origin-wide permission and some browsers prompt for it, so the app should call it at a moment of its choosing (for example when the first change is queued).
