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

When the online mutation succeeds, the result value is `{ kind: 'online', data }`. When TSDF queues the mutation for offline replay, the result value is `{ kind: 'queued' }`. The descriptor may also be `undefined` for calls that only queue in some cases, see [Mutations - Return Value](./mutations.md#return-value).

A mutation is also queued while online when older mutations for the same entities (the operation's `getEntityRefs`) or for the entities it depends on (`dependsOn`), or queued mutations that depend on an entity it changes (e.g. a queued subfolder creation and a delete of its folder), are still waiting in the queue, for example right after reconnecting while the replay is in flight. Sent on its own it would reach the server before them (and be overwritten, or reference an entity the server does not have yet), so it joins the queue and is replayed in the order the user made the changes. The same applies while the creation of an entity of another store the operation declares in `cancelledWith` is still queued (e.g. a comment added to a task whose creation is being replayed).

Queued mutations and pending resolutions are persisted through the store's own `persistentStorage.adapter`, and the cached entries they reference are protected from cache expiry until the queue is replayed or discarded. They are not migrated when a store's adapter changes: let the queue drain first. See [Changing a store's adapter](./persistent-storage.md#changing-a-stores-adapter).

The mutation promise resolves only after the queue write has settled, so a mutation is never reported as queued while its write is still in flight. If the storage adapter cannot write the queue at all (for example the browser lost its IndexedDB connection and a new one cannot be opened), the failure is reported through `onPersistentStorageError`, but the result is still `{ kind: 'queued' }`: the mutation stays queued in memory, its optimistic state stays visible, and it is replayed if the session recovers in the same page load. It is not on disk, so it is lost if the page is reloaded first. Treat an `onPersistentStorageError` call while offline as "pending changes may not survive a reload".

Without an active offline session — `getSessionKey()` returns `false`, or the [session gate](#session-gate) is closed — the same call runs as a plain online mutation: `mutation` is called, a success resolves with `{ kind: 'online', data }`, and a failure goes through the normal error handling (optimistic update rolled back, `onMutationError` called). Nothing is queued.

Queued work belongs to the session key it was queued in. When `getSessionKey()` changes without a reload (logout, or switching to another org or tenant), the replay of the previous session stops before its next step: TSDF does not start uploads of that session, call its `getServerSnapshot` / `shouldSkipSync` / `detectConflict` hooks, or call its `execute`. The entry being replayed stays queued as it was (no failed attempt, no resolution), and it is replayed once that session key is active again. A request `execute` already sent, or an upload transport already running, cannot be recalled: an upload that finishes is kept for that session, and one that fails after the switch does not count as a failure of the operation. The upload transport receives the `sessionKey` that owns the upload, so it can send the file with that session's credentials rather than the ones of the session now active. A mutation that runs online right away stops the same way while its uploads are sent, see [Direct runs](#direct-runs).

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

- **Failure classification.** When a fetch, a mutation or the replay of a queued mutation fails, or the app [reports the failure of its own request](#failures-of-the-apps-own-requests), the session runs the check and applies the answer.
- **Recovery checks.** While a mode is active because of a failure, its recovery probe runs the check on that mode's `recoveryProbe` cadence (network: 5s growing to 60s, outage: 30s growing to 5min by default). `'up'` ends the offline mode — both causes at once when both are active. `'outage'` during network mode means the device reaches the backend again but the backend is down: outage mode takes over, or, when outage mode is disabled, network mode just ends and requests (including the replay of queued mutations) fail with their own errors. `'unreachable'` during outage mode activates network mode and keeps the outage, since nothing can be said about it until the backend is reachable. With a health check, `outage.recoveryCheck` is optional.

In both places an answer only activates a mode that is enabled (`network.enabled` / `outage.enabled`, including runtime overrides). An answer for a disabled mode is ignored: a failed request is left to its own error.

### `'up'` means the failure belongs to the request

When the check answers `'up'` for a failed request, the session stays online and that request's own failure handling applies, even if the endpoint it called is down. For example, an upload endpoint answering 503 while the API health check passes:

- a fetch or a direct mutation fails with its own error;
- a queued mutation being replayed goes through `classifyRetryableFailure` and the `replayRetry` budget, and ends in a `retry-exhausted` resolution (see [Conflict Resolution](#conflict-resolution)).

If the session should pause for that service instead, make `check` cover it (answer `'outage'` when it is down) or return `'outage'` for its failures from `classifyFailure`.

### One request for many failures

While a check is in flight, every failure and recovery tick that needs an answer waits for that same call: a burst of requests failing right when the backend goes down costs one health request. Failures that arrive while the session is already in offline mode do not run the check at all — the active mode explains them, and asking "are we back?" is the job of the recovery checks.

By default a finished answer is not reused. A cached `'up'` could hide an outage that started right after it, so the next failure after a check has settled starts a new one. The check is never called on the success path.

When the check is expensive, an endpoint that keeps failing while the backend is up costs one check per failure, which adds load right when the backend is degraded. `healthCheck.reuseUpForFailuresMs` lets the following failures of the same tab reuse an `'up'` answer for that long:

```ts
healthCheck: {
  check: checkApiHealth,
  // A failure answered "up" explains the next failures for 30s
  reuseUpForFailuresMs: 30_000,
},
```

Inside the window a failure is left to its request without asking the check, so an outage that starts inside it is only noticed by the first failure after it ends. Until then its failures get the handling of [a failure that belongs to the request](#up-means-the-failure-belongs-to-the-request): a direct mutation fails with its own error instead of being queued, and a queued mutation being replayed goes through `classifyRetryableFailure` and the `replayRetry` budget, and can end in a `retry-exhausted` resolution instead of staying queued until the backend recovers. Keep the window short. The reuse never decides recovery:

- only an `'up'` answer to a failure classification starts the window, and only failure classification reads it. Recovery checks always run the check, and their answers are not reused;
- the window ends early when the session enters an offline mode, for any reason, including the browser going offline or another tab entering one.

A failure that arrives while a check is in flight still waits for that call rather than reusing an older answer.

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

### Failures of the app's own requests

Requests the app sends outside the stores, such as a file upload made with its own API client, fail without the session seeing it. A lost connection only that request noticed then leaves the session online. `storeManager.reportOfflineFailure(error, { operationName? })` hands such a failure to the session, which handles it like the failure of an offline-enabled mutation:

1. It reads the network detection again. If that puts the session in an offline mode, no hook is called.
2. Otherwise `classifyFailure(error, ctx)` runs with `ctx.phase: 'app'`, `ctx.operationName` and no `ctx.storeType`. When it answers `'unknown'` (or is not configured), the health check runs. The health check follows the same rules as for store failures: a check in flight is shared, `reuseUpForFailuresMs` applies, and a failure while the session is already offline does not run it.

It resolves to the mode the session is in afterwards: `'network'` or `'outage'` when it is offline, or `'ignore'` when it stays online and the failure belongs to the request. The app can then keep the work for later instead of failing:

```ts
async function attachFile(id: string, file: File) {
  try {
    return { kind: 'uploaded', ref: await api.uploadFile(file) } as const;
  } catch (error) {
    const mode = await storeManager.reportOfflineFailure(error, {
      operationName: 'uploadFile',
    });
    const { mutationQueueing } = storeManager.getOfflineRuntimeConfig();
    if (mode === 'ignore' || mutationQueueing[mode] === 'disallow') {
      throw error;
    }

    // The session is offline now: stage the file for a queued mutation that
    // depends on it (see Uploads), it is uploaded once the session recovers
    (await storeManager.saveOfflineUpload({ id, file })).unwrap();
    return { kind: 'staged', id } as const;
  }
}
```

The answer is the session's mode, whatever `mutationQueueing` says: when that mode's policy is `'disallow'`, the mutation that would use the staged file runs online and fails, so check it before staging, as above. A mode that is disabled is never entered. It rejects only when `classifyFailure` or `network.getIsOffline` throws (or returns a promise that rejects). While the session gate is closed, when there is no active session key or when no `offlineSession` is configured, it resolves to `'ignore'` without calling `classifyFailure` or `healthCheck`. There is nothing to report on success: the session leaves offline mode through its usual recovery checks. Those checks run while an offline-enabled store is in use in the tab, so a mode entered from a screen that uses none stays on until one is used.

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

The list query `awaitItemFetch`, `getItemFromStateOrFetch`, `awaitListQueryFetch` and `getQueryFromStateOrFetch` follow the same rule: a read whose requested fields are all cached resolves with the cached data, and a read requesting fields that were never loaded (for any item of the query, with `fields: '*'` included) resolves with the offline error instead of the partial item. The failed read leaves the cached item or query as it was.

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
- `dependsOn({ input })` - Optional dependencies on other offline entities of the same store.
- `cancelledWith({ input })` - Optional entities of other stores whose cancelled creation or successful delete also drops this work, whose queued creation this work is queued behind, and whose creation waiting for a resolution holds it. See [Deleting entities created offline](#deleting-entities-created-offline).

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
- `queries` follows `addItemToState`, except that queries saved in persistent storage but not loaded yet (after a restart, before a screen reads them) are loaded first, so the row also reaches them. A filter function is matched against them too: every query of the store saved in persistent storage is loaded for it, so prefer query payloads when the lists are known. The queries loaded this way, and their rows, count as recently used for storage expiry and eviction.
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

### Following a temp entity to its final payload

When a queued creation is saved, TSDF replaces the temp payload with the final one: the item state, the query memberships (the saved item takes the place of the temp row) and the offline state of the item. This happens in every open tab of the session, whichever tab sent the creation.

Code that keeps a temp payload outside the store (a route open on the record, a selection, an embedded frame that created it) can follow the record in two ways:

```ts
// Called in every tab when the creation is saved
const stopListening = userStore.storeEvents.on(
  'tempEntityReconciled',
  ({ payload: { tempId, finalPayload } }) => {
    if (openedUserPayload.id === tempId.id) openUser(finalPayload);
  },
);

// Or ask later, for a payload that may still be the temp one
const userPayload = userStore.resolveTempItemPayload(openedUserPayload);
```

`resolveTempItemPayload(payload)` returns the final payload once the item was saved, and the given payload otherwise. Collection and list-query stores have both the event and the lookup.

- The mapping is kept in memory, for the tabs that were open when the creation was saved (the 1000 most recent creations per store). A tab opened or reloaded afterwards starts from the saved item and cannot resolve the old temp payload, so replace temp payloads kept in URLs when the event fires.
- A tab that does not hold the temp item is still told about it and can resolve it.

### Deleting entities created offline

When the user deletes something that was created offline, the server may have never seen it. Declare this on the delete operation with `supersedes.dropSelfIfTempLifecycleCancelled`:

```ts
deleteTask: {
  kind: 'delete',
  inputSchema: deleteTaskSchema,
  getEntityRefs: ({ input }) => [input.itemId],
  supersedes: { scope: 'same-entity', dropSelfIfTempLifecycleCancelled: true },
  execute: async ({ input }) => {
    try {
      await api.deleteTask(input.itemId);
    } catch (error) {
      // The task is already gone: the delete is done
      if (!isNotFoundError(error)) throw error;
    }
  },
},
```

What happens depends on whether the creation was already sent:

- **Never sent** (still waiting in the queue, or held behind the creation of another entity that waits for a resolution): nothing is sent. TSDF drops the creation, the queued edits of the entity, the delete itself and the queued work that depends on the entity (`dependsOn`), then removes the temporary entity from the store and its lists. The same applies to a `create` of an item whose id the app generates on the client: the item is removed instead of a temporary entity.
- **Created together with other entities** (a `tempEntities` operation that creates several entities at once): the creation is never cancelled, since the other entities still need it. The delete is queued behind it and sent with the server id, as for a creation that was sent.
- **Sent** (`syncing`, `needs-confirmation`, queued again after a `retry`, or, for an id the app generates, queued after its direct online request failed or sent again with `requeue` after a conflict): the server may have the entity, so the creation is kept and the delete stays queued behind it. Once the server id is known the delete is sent with it. `execute` should treat a not-found answer as success, as above: the server answers not-found when the creation never reached it, or when an earlier delete attempt did. The work of other stores declared `cancelledWith` the entity is dropped once the delete succeeds (see below).
- **Waiting for a manual resolution**: the creation is kept too, and the delete is held behind that resolution. See [Entities whose creation waits for a resolution](#entities-whose-creation-waits-for-a-resolution).

An edit still waiting for its `debounce` window is not queued yet, so the delete can't drop it: it would be queued once the window ends, for an entity the server may not have. Cancel it with [`cancelDebouncedMutation`](./mutations.md#cancelling-a-debounced-mutation) before deleting.

`getItemOfflineState(payload)` tells the first case apart before deleting: `isUnsentCreation && !creationAttempted` means the delete only discards local work, unless the item was created together with other entities. A temp entity whose creation was queued after its direct online request failed, or sent again with `requeue` after a conflict, is in that case too: an earlier request may have created a server item, but the temporary payload can't target it, so the delete leaves that item as is. An item whose id the app generates also reports `isUnsentCreation: true` until the server confirms its creation; since the delete can target its id, it reports `creationAttempted: true` (and the delete is sent) once the creation was sent, queued after its direct online request failed or sent again with `requeue`.

Work queued in **other stores** for the cancelled entity is not known to its store. Declare the relation with `cancelledWith` in the other store's operation:

```ts
// comments store
addComment: {
  kind: 'create',
  // ...inputSchema, tempEntity, getEntityRefs, execute
  // `tasks` is the `id` of the store that owns the task
  cancelledWith: ({ input }) => [{ storeName: 'tasks', entityRef: input.taskId }],
},
```

When the creation of that task is cancelled as above, or its manual resolution is discarded, the queued comments are dropped with it and their temporary entities are removed. A comment added with a client-generated id instead of a temporary entity is removed the same way when it was never sent, or when it was held behind the task's creation, with the work queued on it and the work of other stores declared as `cancelledWith` it. While the task's creation is still queued, a comment added online is queued behind it instead of sent directly. While the task's creation waits for a resolution, the comments are held behind it like the work of the tasks store (see [Entities whose creation waits for a resolution](#entities-whose-creation-waits-for-a-resolution)). `cancelledWith` does not rewrite the input when the task gets its server id, so it fits entities whose id the app generates on the client best. It only reaches stores that are instantiated in the tab: work is held only when the tab that queues or replays it has the task's store, and the decision about the creation (cancel, discard, retry) only reaches the stores of the tab where it is made. Held work a decision did not reach stays as a resolution of its own, no longer blocked, for the user to retry or discard.

The work is dropped the same way when a `kind: 'delete'` operation of the tasks store that references the task succeeds, whether the task was created offline with a client-generated id or already existed on the server: once the delete is sent online or replayed successfully, the comments still queued for the task (and their manual resolutions) are dropped instead of being sent for a task the server no longer has. As for a cancellation, their temporary entities and client-generated items are removed, their staged uploads are released, and the entities they changed are refetched. A comment being sent at that moment is left to finish. A delete only drops this work once it succeeds: while it is queued, the comments keep their place in the replay order, and when it fails into a manual resolution or is discarded they are sent as usual. They are also kept when the tasks store still has a creation of that task queued or waiting for a resolution (the task was created again with the same client-generated id after the delete): they then follow that creation. Every entity the delete references (`getEntityRefs`) counts as deleted, so a delete operation should reference only the entities it removes. Comments that declare the task by its temporary id are not matched by a delete sent with its server id, since `cancelledWith` does not rewrite the input. Like the cancellation, this only reaches the stores instantiated in the tab where the delete succeeds (the tab that replays the queue, or the one that sent it online); the records they drop are removed in the other tabs too.

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

- `discard` - Drop the resolution record. The optimistic changes of the discarded mutation cannot be rolled back locally, so TSDF refetches what the operation referenced (`getEntityRefs`): the document, the collection item, or the list query item together with the store's lists (the change may have moved or removed the row). An entity that other changes still wait for a decision on is not refetched, since the refetch would replace those changes: it is revalidated once the last one is handled. Likewise, while other changes of a list query store still wait for a manual resolution, only the item is refetched: its lists are revalidated once the last one is handled. Discarding a temp create removes the temp entity and everything queued on top of it; existing entities changed on top of it are refetched. Discarding a `create` without temp entity (the app generated the id on the client) removes the items it created (its `getEntityRefs`) from the store, its lists and the persisted cache, like a temp entity, instead of refetching them: a discarded creation is treated as never sent. If the server did create one (the response of an earlier replay attempt was lost, or a conflict reported that it already exists), it stays removed locally until something fetches it again: the recovery revalidation of a list query store's lists brings it back (right away when no other change waits for a decision, otherwise once the last one is handled), but a collection item, or a list query item outside every loaded list, shows `deleted` until it is fetched again, e.g. after a reload. Discarding a temp create has the same tradeoff. Like the changes made on top of a temp entity, the changes queued on such an item wait behind its failed creation (see [Entities whose creation waits for a resolution](#entities-whose-creation-waits-for-a-resolution)), so discarding the creation drops them with it.
- `requeue` - Queue replacement input for an operation conflict.
- `commit` - Accept an externally completed resolution result.
- `retry` - Retry a retry-exhausted record.

A mutation that exhausted its replay retries leaves the queue when it becomes a resolution record, so the mutations queued behind it keep replaying; only the ones that depend on it (queued on top of the entity it creates) wait with it.

Use `parseOfflineResolutionConflict(resolution)` to narrow a persisted resolution back to the operation-specific conflict/input type before rendering a manual resolution UI.

### Entities whose creation waits for a resolution

While the creation of an entity made offline waits for a resolution, the server does not know the entity, so nothing else can be sent for it. This applies to temp entities and to the items a `create` without temp entity adds with an id the app generates on the client. The mutations that target or depend on it become blocked resolutions behind the creation (`blockedResolutionCount > 0`, error `Blocked by unresolved dependency`), whether they were queued before the creation failed or made afterwards, online or offline. `performMutation(...)` returns `{ kind: 'queued' }` for them and the optimistic update stays visible.

They follow the decision about the creation: `retry` (default scope) sends the creation again and then the blocked mutations with the server id, `discard` drops them with the creation. For a creation that hit a conflict, `requeue` sends them after the new creation, and `commit` sends them with the ref of the entity the result keeps. A `requeue` that creates other items than the original creation (e.g. a new client-generated id after an "id already taken" conflict) does not send them: they stay as resolutions of their own for the user to decide. This includes a delete with `dropSelfIfTempLifecycleCancelled`: the creation may have reached the server, so it is not cancelled locally; the delete is sent after the creation is retried, or dropped when it is discarded.

A blocked mutation was never sent, so a later mutation of the same entity treats it like an unsent queued one: an `accumulation` operation merges into it, and a `supersedes` operation prunes it. This keeps the order the user made the changes in, e.g. moving a task under the waiting entity and then back under a server task sends only the second move, and retrying the creation does not move the task again. When the merged input no longer depends on the waiting entity, it is queued and sent right away. To make this possible, an online mutation of such an operation for an entity with blocked work is queued instead of sent directly. A mutation of an operation with neither `accumulation` nor `supersedes` does not touch the blocked one: it is sent first, and the blocked one is sent after it once the creation is retried.

When the merged input still depends on the waiting entity, the changes merged into it go with the decision about the creation too: discarding the creation also drops them, e.g. a rename of a server task merged into its held move under the waiting entity.

The work of other stores declared as `cancelledWith` the waiting entity is held the same way, in its own store: it is a blocked resolution of that store, sent after the creation on `retry` (default scope), `requeue` or `commit`, and dropped with it on `discard`. See [Deleting entities created offline](#deleting-entities-created-offline) for its limits.

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

List-query stores additionally expose `usePendingOfflineItems(...)`, which returns pending creates/updates and pending deletes without mounting or fetching a query. Its `selector` receives each item's [per-item state](#per-item-state) as a third argument, so a "pending changes" list can tell items created offline (`isUnsentCreation`) from edited ones without reading `useOfflineEntities()`.

### Connection state

`status.isOfflineMode` tells whether the session is in offline mode, and `status.network.active` / `status.outage.active` which cause put it there. `status.isNetworkDetectedOffline` is what the network detection (`network.getIsOffline`, or `navigator.onLine` by default, and [forced offline mode](#forced-offline-mode)) last reported, whether or not the session follows it (forced offline mode only counts while network mode is enabled and the session gate is open). It is also reported while the [session gate](#session-gate) is closed or network mode is disabled, so the same status can drive both the offline mode UI and a "no connection" banner for users without offline mode:

```tsx
const status = storeManager.useOfflineStatus();

const showNoConnection =
  status.isNetworkDetectedOffline && !status.isOfflineMode;
```

- It requires `offlineSession.network`, and is always `false` without it or while there is no active session key.
- It is updated on the browser `online` / `offline` events (unless `network.listenToBrowserEvents` is `false`) and before fetches and mutations.
- A failure classified as `network` (by `classifyFailure` or the [health check](#health-check)) does not change it: it only activates `network.active`.
- It is local to the tab: it is not persisted nor shared with the other tabs of the session.

### Per-item state

Collection and list-query stores expose `useItemOfflineState(itemPayload)` / `getItemOfflineState(itemPayload)` for per-row UI such as sync badges. They return `null` when the item has nothing queued, otherwise `{ syncState, pendingMutations, requiresResolution, isUnsentCreation, creationAttempted }`:

```tsx
const offlineState = userStore.useItemOfflineState({ id: 1 });
// null | { syncState: 'pending', pendingMutations: 1, requiresResolution: false, isUnsentCreation: false, creationAttempted: false }
```

Prefer it over building a map from `useOfflineEntities()`: a component using the hook re-renders only when the state of its own item changes. `isUnsentCreation` is `true` for an item created offline until the server confirms it; after that the temporary payload returns `null` and the final payload reports the mutations still queued for the item. `creationAttempted` turns `true` once that creation starts being sent: before that, deleting the item only discards local work (see [Deleting entities created offline](#deleting-entities-created-offline)). See [Hooks - useItemOfflineState](./hooks.md#useitemofflinestate).

Document stores hold a single entity, so they do not need a per-item reader: use `useDocument().pendingSync` or `useOfflineEntities()[0]`.

## Multiple Tabs

Tabs of the same session share one offline queue. Every tab can queue mutations and every tab shows the same pending state, but only one tab sends the queued work:

- The **leading tab** replays the queue: the visible tab, or the one that was visible most recently. `useOfflineStatus().isLeader` tells whether the current tab leads.
- A mutation queued in any other tab is sent by the leading tab after the connection recovers, in the order the mutations were queued across tabs. No reload or tab switch is needed.
- Every queued mutation is sent once. A cross-tab lock (Web Locks API) keeps two tabs from replaying a store's queue at the same time, and a tab drops an entry as soon as another tab reports it as sent, so it does not send it again when it leads later. Where the Web Locks API is unavailable (pages served over plain `http` other than `localhost`), this guarantee does not hold and TSDF logs a warning. It also only holds between tabs running the same app version (`getAppVersion`) and the same TSDF release: tabs on different versions do not see each other's messages, so after a deploy an old tab and a new tab can both send the same queued mutation.
- When the leading tab sends a temp-entity creation queued in another tab, every tab with the store replaces the temp item with the saved one and emits `tempEntityReconciled`, so a view that follows the temp id can switch to the final one in any tab. See [Following a temp entity to its final payload](#following-a-temp-entity-to-its-final-payload).
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

- it never enters offline mode: network detection is ignored and neither `classifyFailure` nor `healthCheck` is called. The offline status reports `isOfflineMode: false`, and `getOfflineRuntimeConfig()` reports both modes as not enabled. `isNetworkDetectedOffline` still reports the connectivity the network detection sees (see [Connection state](#connection-state)), so the app can show a "no connection" state without reading `navigator.onLine` itself. For that, `network.getIsOffline` keeps being called on every fetch, mutation and status read, so a `getIsOffline` that pings a server keeps sending those requests while the gate is closed
- fetches always go to the network and fail with their normal errors
- mutations with an `offline` descriptor run as plain online mutations (see [Queuing Mutations](#queuing-mutations))

Mutations already queued when the gate closes are neither deleted nor replayed. They stay in persistent storage untouched, still listed by the offline entities / resolutions APIs, and are replayed once the gate reopens and the session is online. A queued mutation whose replay request fails because the gate closed mid-flight goes back to the queue as pending. Mutations made while the gate is closed go straight to the server, so they are not ordered after older mutations still waiting in the queue for the same entities: when that matters, close the gate only once the offline entities list is empty.

The callback is read before every fetch and every mutation with an `offline` descriptor, on browser `online` / `offline` events, before each recovery check and before each queued mutation is replayed, so it must be synchronous and cheap (read a variable or a store, no I/O). The app does not have to call anything for a flip to apply to the next fetch or mutation. To apply it right away — clear the offline status in the UI as soon as the gate closes, or start replaying the queue as soon as it reopens on an idle screen — call `storeManager.setOfflineRuntimeConfig({})` after changing the value: every runtime config update re-reads the gate. Runtime overrides and the upload helpers are not affected by the gate.

The tabs of a session key share its offline status and its replay, so `enabled()` must return the same value in every tab of that session key. A tab with the gate closed would clear an offline mode another tab still relies on, and a leading tab with the gate closed holds back the replay of every tab. To gate per workspace, include the workspace in the session key.

### Forced offline mode

`setForcedOfflineMode(forced)` makes the session behave as if the network were down, without cutting the real connection:

```ts
const result = await storeManager.setForcedOfflineMode(true);

storeManager.getOfflineStatus().isForcedOffline; // true

await storeManager.setForcedOfflineMode(false);
```

- While forced, the session's network detection reports offline regardless of `navigator.onLine` / `network.getIsOffline`: fetches are served from cache, offline-enabled mutations are queued, and neither replay nor recovery checks run. Successful requests and browser `online` events cannot end it.
- Only the offline session goes offline: the real connection stays up, so requests that do not go through the session still reach the server and succeed. That includes fetches of stores without `persistentStorage.offline`, mutations without an `offline` descriptor, offline-enabled mutations while `mutationQueueing.network` is `'disallow'`, and the app's own requests. Cut the connection (e.g. Playwright's `context.setOffline(true)`) to test how those fail.
- The flag is persisted per session key in `localStorage` and read synchronously when the session boots, so it survives reloads and the first fetches after a reload are already offline. It stays on until it is turned off.
- It is shared with the other tabs of the same session: open tabs follow the toggle, tabs opened later boot with it.
- Turning it off hands control back to the real network detection. If the network is up, the session recovers and replays queued work exactly like a normal reconnect; if the detection (`navigator.onLine` / `network.getIsOffline`) still reports offline, the session stays offline.
- It is a simulated network loss, so it requires `offlineSession.network` and only takes effect while network mode is enabled and the [session gate](#session-gate) is open. The call resolves to `Result.err(...)` when `offlineSession.network` is not configured or there is no active session key.
- The returned promise resolves once the flag is persisted and, when turning it off, once the network detection has run again, so it is safe to reload right after awaiting it. A failed storage write is not reported in the result: like every other persistence write it goes to `onPersistentStorageError` and the call still resolves to `Result.ok`. In that case the change applies in the open tabs but does not survive a reload.

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

When several pages of the same session are open, replay is done by the leading tab (the visible, most recently focused one), which also sends the edits queued in the other pages, same as for a real reconnect (see [Multiple Tabs](#multiple-tabs)). A multi-page test that asserts which page sent a request should expect it from the page that was opened or focused last.

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

- `install()` / `uninstall()` replace and restore `navigator.onLine` (requires a DOM environment such as `happy-dom` or `jsdom`). That is enough for sessions using the default detection. `uninstall()` also resets the status to its initial value, so a test that ends offline does not leave the next one offline.
- `network.config` is a ready-to-use `offlineSession.network` value (`{ enabled: true, getIsOffline }`) for sessions that should read the mock directly.
- `goOffline()` / `goOnline()` change the status and dispatch the window `offline` / `online` events, like the browser does. `setOffline()` / `setOnline()` change it silently, e.g. to prepare the status before the app boots.
- `isOnline()` / `isOffline()` read the mocked status.

## Uploads

Configure uploads on `offlineSession.uploads` when queued mutations depend on local files. The manager exposes upload helpers:

- `saveOfflineUpload({ id, file, metadata? })`
- `replaceOfflineUpload({ id, file, metadata? })`
- `loadOfflineUpload(id)`
- `deleteOfflineUpload(id)`
- `resolveOfflineUpload(id)`
- `resolveOfflineUploads(ids)`
- `getResolvedOfflineUploadRef(id)` — see [Following a released upload to its server ref](#following-a-released-upload-to-its-server-ref)
- `useOfflineUploads()`
- `useOfflineUploadFile(id)` — see [Rendering staged files](#rendering-staged-files)

Operations can declare `dependsOnUploads({ input })` and then read resolved upload refs from `execute({ uploads })`. An upload the operation can be sent without is declared as `{ id, optional: true }`, see [Optional uploads](#optional-uploads). When queued mutations are merged (`accumulation.mergeInput`), the dependencies are computed again from the merged input, so files referenced by any of the merged edits are uploaded before `execute` runs. `opfsOfflineUploadAdapter` is exported as a built-in OPFS-backed upload adapter.

### Direct runs

A mutation with an `offline` descriptor that runs online right away gets the same uploads: TSDF uploads the ids the operation's `dependsOnUploads` returns for its input before calling `mutation`, and passes the refs in `uploads`, like `execute` gets them on replay. Document stores add it to the `mutation` context, collection and list query stores pass it as the second argument:

```ts
// Shared by the direct run and the replay
function sendAvatar(
  input: { id: number; uploadId: string },
  uploads: { resolvedRefsById: Record<string, UploadRef> },
) {
  const avatar = uploads.resolvedRefsById[input.uploadId];
  if (!avatar) throw new Error('Missing avatar upload');

  return api.setUserAvatar(input.id, avatar.fileId);
}

// In the operation definition:
execute: ({ input, uploads }) => sendAvatar(input, uploads),

// The mutation:
const input = { id: 1, uploadId: attachmentId };
await userStore.performMutation(
  { id: 1 },
  {
    mutation: (_payload, { uploads }) => sendAvatar(input, uploads),
    offline: { operation: 'setAvatar', input },
  },
);
```

- Once `mutation` succeeds, the uploads are released as after a replay: deleted unless queued work still declares them, and their ids keep resolving to the same refs for the rest of the app session.
- When the direct request fails and the mutation is queued instead, the queued mutation declares the uploads, so they are kept. They are already uploaded, so the replay sends the same refs without uploading again.
- When the request fails with its own error, the uploads are kept as they are, for the next attempt.
- With the [session gate](#session-gate) closed the uploads are resolved and released the same way. Nothing is queued then.
- With `offline: descriptor | undefined`, `uploads` (the second argument for collection and list query stores) is optional in the `mutation` type: it is set when the descriptor is, and `undefined` when the call runs as a plain online mutation.
- A failed upload is handled as described in [Dependency uploads of a direct run](#dependency-uploads-of-a-direct-run). `mutation` is not called.
- When `getSessionKey()` changes while the uploads are sent (switching to another org, logout), `mutation` is not called and no upload of the previous session is started. The mutation fails with an error whose `id` is `'offline-session-unavailable'` (code 460) and goes through the normal error handling. It is not queued, because it would then be replayed in a session the user left. The uploads stay staged in the previous session: one that finished keeps its ref, so running the mutation again in that session does not upload it again.
- Don't resolve or delete these uploads yourself with `resolveOfflineUpload(s)` / `deleteOfflineUpload`: an upload deleted before the request is sent is gone when the mutation falls back to the queue, and its replay fails.

### Upload refs

The value the `upload` transport resolves to is the upload ref: whatever the server needs to reference the uploaded file (a string, or an object such as `{ fileId, url }`). `createStoreManager` infers its type from the transport, so it does not have to be narrowed by hand:

```ts
const uploadRefSchema = rc_object({ fileId: rc_string, url: rc_string });

const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  errorNormalizer: normalizeError,
  offlineSession: {
    uploads: {
      adapter: opfsOfflineUploadAdapter,
      // Resolves to `{ fileId: string; url: string }`.
      upload: ({ file, onProgress }) => api.uploadFile(file, onProgress),
      // Optional: validates refs restored from storage or other tabs.
      resolvedRefSchema: uploadRefSchema,
    },
  },
});

// `{ fileId: string; url: string }`
type UploadRef = StoreManagerUploadRef<typeof storeManager>;

const result = await storeManager.resolveOfflineUpload(attachmentId);
if (result.ok) console.log(result.value.url);
```

- `resolveOfflineUpload(id)`, `resolveOfflineUploads(ids)` and the `resolvedRef` of the `OfflineUpload` entries returned by `getOfflineUploads()` / `useOfflineUploads()` are typed with the inferred ref.
- Let the manager type be inferred. Annotating it as plain `StoreManager` (or its config as plain `OfflineSessionConfig`) replaces the inferred ref with the default `ValidPayload`. A manager with a typed ref is still accepted wherever a plain `StoreManager` is expected, including `storeManager` on every store.
- Stores are created with explicit type arguments, so TypeScript cannot carry the ref type from the `storeManager` option into `execute`. Pass it as the last type argument of `DefineDocumentOfflineOperations`, `DefineCollectionOfflineOperations` or `DefineListQueryOfflineOperations` (the single-operation `*OfflineOperationDefinition` aliases take it last too). Without it, operations keep the default `ValidPayload`:

```ts
type UserOfflineOperations = DefineListQueryOfflineOperations<
  User,
  UsersQuery,
  UserPayload,
  { setAvatar: DefineOfflineOperation<{ id: number; uploadId: string }> },
  UploadRef
>;

// In the operation definition:
dependsOnUploads: ({ input }) => [input.uploadId],
execute: ({ input, uploads }) => {
  // `UploadRef | undefined`
  const avatar = uploads.resolvedRefsById[input.uploadId];
  if (!avatar) throw new Error('Missing avatar upload');

  return api.setUserAvatar(input.id, avatar.fileId);
},
```

#### Validating restored refs

A ref returned by the `upload` transport is trusted. A ref can also reach the session without going through the transport: it is persisted with the upload record, so it is read back from the upload adapter after a reload, and other browser tabs publish the refs they resolved. Either source can come from a different app version with a different ref shape.

Set `resolvedRefSchema` to validate those refs. It accepts the same schemas as an operation `inputSchema` (a `runcheck` type or a synchronous Standard Schema such as zod), and its output has to agree with what the transport returns: the inferred ref type is what both produce.

- Refs restored from the upload adapter are parsed once when their record is loaded, and refs received from another tab once per record version.
- A ref that fails the schema is dropped and its upload goes back to `pending`. The staged file is kept with the record, so the next `resolveOfflineUpload(s)` call or the replay of an operation that depends on the upload sends the file through the transport again and stores the new ref. The dependent operation is not failed, and `execute` never receives the invalid ref. The file uploaded under the old ref is not cleaned up by TSDF.
- The exception is a ref another tab sends when it deletes an upload that was already sent: its staged file is gone, so a ref that fails the schema can't be uploaded again, and its id stops resolving (`resolveOfflineUpload(s)` returns an unknown upload error).
- Queued operations only persist upload ids, plus the refs of uploads that were already sent and deleted when the operation was queued (see [Upload lifecycle](#upload-lifecycle)). Their refs are resolved when the operation replays, so they are covered by the same validation: a kept ref that fails the schema can't be uploaded again (its file is gone), so the id is unknown.
- Without `resolvedRefSchema`, restored refs are exposed as they were stored.

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
- A mutation that declares the upload and [runs directly](#direct-runs) releases it the same way once its request succeeds.
- References are session-wide. An upload declared by queued mutations of several stores is deleted only after the last of them is gone. Only stores created in the tab count: an upload staged with `saveOfflineUpload` and shared with a store that is not created in the tab yet (a code-split screen, or the app restarted on another screen) can be deleted when the stores already created release it, and that store's queued mutation then fails to replay. If an upload id is shared across lazily created stores, create those stores before their queued work replays, or stage a separate upload for each store. Files attached directly to a mutation don't have this limit: they record the store that queued them (see `storeName` above).
- An upload that no queued work declared yet is never deleted for being unreferenced: the app stages the file first and queues the mutation afterwards. It stays until a mutation that declares it is queued and leaves the queue or runs directly, until the app calls `deleteOfflineUpload(id)`, or until it expires. Unreferenced uploads expire after the session has been online for one week without interruption (going offline restarts the window). This also applies to uploads the app resolves itself with `resolveOfflineUpload(s)`, e.g. for a mutation without `offline` descriptor, because they never enter the queue.

After an upload that was already sent is deleted, its id keeps resolving to the same server ref for the rest of the app session, in every tab open when it was deleted: a mutation queued later that still declares it (for example from optimistic or draft data that was not updated with the server ref yet) replays with that ref without uploading again, and `resolveOfflineUpload(id)` returns it. The session keeps this ref in memory only, but a mutation queued in that window persists the ref with its queue entry (and with the resolution it may turn into), so it still replays with it after a reload or from a tab opened later. Elsewhere (a new mutation after a reload, in a tab opened later, or after `deleteOfflineUpload(id)`) the id is unknown again, so write the server ref into the data, or stage the file again with `saveOfflineUpload` before reusing it. Uploads deleted before they were sent (discarded, superseded or cancelled work) are not kept.

Files attached directly to a mutation (`upload: { ... }` in `performMutation`) belong to that single queued mutation and are deleted with it in the same situations.

### Rendering staged files

An entity updated optimistically with a local file usually stores the staged upload id as its file ref. `storeManager.useOfflineUploadFile(id)` reads that staged file for rendering — also after a reload, when the object URLs the app created earlier are dead:

```tsx
type FileRef =
  | { kind: 'local'; uploadId: string }
  | { kind: 'server'; url: string };

function Thumbnail({ file }: { file: FileRef }) {
  // A falsy id disables the hook, so it is only used for local refs.
  const staged = storeManager.useOfflineUploadFile(
    file.kind === 'local' && file.uploadId,
  );

  if (file.kind === 'server') return <img src={file.url} />;
  if (staged.status === 'success') return <img src={staged.url} />;

  // `missing` / `error`: the local file is gone or unreadable.
  return <FilePlaceholder isLoading={staged.status === 'loading'} />;
}
```

The hook returns an `OfflineUploadFile`, a union narrowed by `status`:

- `status` — `idle` (falsy id), `loading`, `success`, `missing` (no upload with this id is staged in the active session) or `error` (the upload adapter failed to read the file; the read is tried again once every component stops using the id, or right away when the id is staged again)
- `url` — object URL of the staged file, managed by TSDF. Only set on `success`
- `file` — the staged `File`, for reading its contents. Only set on `success`
- `error` — the read failure. Only set on `error`
- `resolvedRef` — the server ref of an upload that was sent and then deleted with the queued work or [direct run](#direct-runs) that used it. Only set on `missing`, see [Following a released upload to its server ref](#following-a-released-upload-to-its-server-ref)

Caching and URL lifetime:

- Components using the same id share one read and one object URL, so the hook can be called from as many components as needed.
- A staged file the session already holds is returned on the first render, with no `loading` state. `loading` only shows while the session is still restoring its uploads (right after a reload) or reading an upload it does not hold yet.
- The URL exists while at least one component uses the id. It is revoked about one second after the last one stops using it (unmount or falsy id), so remounts and React StrictMode keep the same URL.
- `replaceOfflineUpload` gives every consumer in the tab a new `url` / `file` and revokes the previous URL. Staging or replacing the id from another tab does not update a file this tab already read until the tab reloads; deletions from another tab apply right away.
- When the upload leaves the session (`deleteOfflineUpload`, retention expiry, or a mutation-attached file being consumed) the status becomes `missing` and the URL is revoked. Staging the same id again makes it available again.
- Use `url` directly in render (`<img src>`, `<a href>`). Do not revoke it, do not keep it outside of render, and do not create extra object URLs from `file`.

The file follows the upload record, not its upload state: it stays available while the upload is `pending`, `uploading` and `uploaded`. To move from the local file to the uploaded one without a gap, derive the id from the entity as in the example above, and write the server ref into the entity when the mutation replays:

- Uploads staged with `saveOfflineUpload` are deleted once the last queued work that declares them leaves the queue (see [Upload lifecycle](#upload-lifecycle)). They are also deleted once a mutation that declares them [runs directly](#direct-runs). Files attached with `performMutation({ upload })` are removed once their mutation replayed. Uploads no mutation declared stay until `deleteOfflineUpload` or retention removes them.
- A replayed mutation releases its uploads after its `onSuccessExecute` ran (and, for a temp entity create, after the result replaced the temp entity). When `onSuccessExecute` writes the server ref into the entity, the local file stays renderable until that render, and from then on the component passes a falsy id and renders the server file.
- A [direct run](#direct-runs) releases its uploads once `mutation` resolves, before `onSuccess` and the `revalidateOnSuccess` refetch. Write the server ref into the entity inside `mutation` to get the same handoff.
- Otherwise the entity keeps the local ref until it is revalidated after the replay or direct run, so the hook reports `missing` in between. In the tabs open when the upload was deleted, that `missing` carries the server ref in `resolvedRef` (see [Following a released upload to its server ref](#following-a-released-upload-to-its-server-ref)), so the component can render the uploaded file until the entity is revalidated. The same happens for work `shouldSkipSync` drops, and in other tabs, whose entities keep the local ref until they refetch.

Outside of these windows, a local ref paired with `missing` and no `resolvedRef` means the staged file was deleted or expired, not that it is about to appear.

#### Following a released upload to its server ref

Some data keeps the staged id after the upload was sent, e.g. a rich text editor whose content references images by upload id and is not rewritten when the save replays. Once the upload is deleted, the hook reports `missing` with the upload's server ref in `resolvedRef`, so the component switches to the uploaded file instead of uploading the file again:

```tsx
function ImageNode({ uploadId }: { uploadId: string }) {
  const staged = storeManager.useOfflineUploadFile(uploadId);

  if (staged.status === 'success') return <img src={staged.url} />;
  // Typed with the upload ref of the manager.
  if (staged.resolvedRef) return <img src={staged.resolvedRef.url} />;

  return <ImagePlaceholder isLoading={staged.status === 'loading'} />;
}
```

Code that runs outside of render (building a mutation input, replacing ids in editor content, cleaning up removed files) reads the same ref synchronously with `storeManager.getResolvedOfflineUploadRef(id)`. It returns the `resolvedRef` of a staged upload in `uploaded` state (the entry `getOfflineUploads()` lists, also when another tab sent it), or the ref of a sent upload that was deleted, and `null` otherwise: not sent yet, last attempt failed, unknown id, or while the session is still restoring its stored uploads after a reload. It is typed with the upload ref of the manager.

```ts
function serializeBody(body: EditorContent) {
  return replaceImageIds(body, (uploadId) =>
    storeManager.getResolvedOfflineUploadRef(uploadId),
  );
}
```

`resolvedRef` is the ref `resolveOfflineUpload(id)` returns for a sent upload that was deleted (see [Upload lifecycle](#upload-lifecycle)) and is kept for as long: in memory, for the rest of the app session, in every tab open when the upload was deleted. Tabs that show the staged file switch to the ref as soon as it is deleted, and components mounted later get it on their first render. It is `null` after a reload, in a tab opened later (until queued work that kept the ref replays there), after `deleteOfflineUpload(id)`, and for uploads deleted before they were sent, so data that must keep its file across reloads still needs the server ref written into it.

### Upload failure handling

The `upload` transport reports a failure by rejecting (throwing). What happens next depends on who started the upload.

#### Dependency uploads during replay

When a queued operation with `dependsOnUploads` replays, a transport failure is classified by the same session hooks as a failed `execute`: `classifyFailure(error, ctx)` and then `classifyRetryableFailure(error, ctx)`. `ctx` is the context of the operation being replayed (`phase: 'sync'`, `storeType`, `operationName`, `sessionKey`) plus `uploadId`, the id of the upload that failed. `execute` is not called for that attempt. Other failures while resolving that upload, such as a storage error reading the staged file, are classified the same way with `uploadId` set, so check the error type instead of assuming every failure with `uploadId` came from the transport.

- **Connection problem or outage** - `classifyFailure` returns `'network'` or `'outage'` (and that mode is enabled, as for any other failure). The session enters that mode, the upload goes back to `pending` (with `lastError` set) and the operation stays queued. Replay runs the upload again when the session recovers. The replay retry budget is not consumed, however long the outage lasts.
- **Transient failure that is safe to repeat** - `classifyFailure` returns `'ignore'` and `classifyRetryableFailure` returns `true`. The upload goes back to `pending` and is sent again on the `replayRetry` cadence (`intervalMs`, 5s by default). After `maxFailures` attempts (3 by default) it is handled as a permanent failure.
- **Permanent failure** (file too large, type not accepted) - no hook recognizes the error, which is the default. The upload becomes `failed` and the operation moves right away to a `retry-exhausted` resolution: `lastReplayError` carries the upload error and `dependencyUploadIds` lists the uploads it depends on. Resolving it with `retry` requeues the operation, which runs the upload again; `discard` removes the operation and, when no other queued work declares the upload, deletes the staged file (see "Upload lifecycle"). An [optional upload](#optional-uploads) is left out instead, and the operation is sent without it.

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

#### Dependency uploads of a direct run

A transport failure while a [direct run](#direct-runs) resolves its uploads is classified like a failed direct request, by `classifyFailure(error, ctx)` with `phase: 'mutation'` and `uploadId` set. The request is never sent.

- When the failure puts the session in offline mode and queueing is allowed for it, the mutation is queued: the upload goes back to `pending` (with `lastError` set) and is sent again by the replay.
- Otherwise the mutation fails with the upload error, like a failed request (`onMutationError` is called and the optimistic update is rolled back), and the upload becomes `failed`. Running the mutation again uploads it again.

With the session gate closed, the failure is not classified: the mutation fails with it.

#### Optional uploads

An operation that can be sent without one of its files declares it as optional: `dependsOnUploads` returns `{ id, optional: true }` for it instead of the plain id. For example a document whose editor images can keep their local reference, while its cover is required:

```ts
dependsOnUploads: ({ input }) => [
  input.coverId,
  ...input.imageIds.map((id) => ({ id, optional: true })),
],
execute: ({ input, uploads }) =>
  api.saveDoc({
    ...input,
    // A refused image is missing from `resolvedRefsById`: its local id stays
    // in the body.
    body: replaceImageIds(input.body, uploads.resolvedRefsById),
  }),
```

When the server refuses an optional upload, the operation is sent without it instead of moving to manual resolution or failing:

- Refused means the failure is permanent, as classified above. During replay: `classifyFailure` keeps the session online and `classifyRetryableFailure` returns `false`, or the replay retries of a retryable failure are used up. During a direct run: the session stays online and `classifyRetryableFailure`, called with `phase: 'mutation'` and `uploadId` set, returns `false`.
- `execute` (or the direct `mutation`) runs with the other uploads. The refused id is missing from `uploads.resolvedRefsById` and listed in `uploads.refusedUploadErrorsById` with the error the transport threw, so the app can keep the local reference, drop it, or tell the user.
- The refused upload is not deleted with the work that declared it, since it was not sent: it stays staged as `failed` with `lastError`, so `useOfflineUploadFile(id)` keeps rendering the file. It is uploaded again when other work that declares it runs, or when `resolveOfflineUpload(id)` is called. Delete it with `deleteOfflineUpload(id)` once the app no longer needs it, otherwise it expires like the uploads no mutation used.
- A connection problem, an outage, or a retryable failure with retries left is handled as for a required upload: the operation waits and is sent with the file once it uploads. In a direct run a retryable failure fails the mutation with the upload error, so running it again uploads the file again.
- A required upload that fails permanently still sends the operation to manual resolution, whatever happened to its optional uploads. An id returned both as a plain id and as optional is required.
- With the session gate closed, upload failures are not classified, so a failed optional upload fails the mutation like a required one.
- Queued work only persists the upload ids: the optional marks are read from the `dependsOnUploads` of the running deploy when an upload fails.

#### `resolveOfflineUpload(s)`

When the app uploads a staged file itself, a transport failure is returned to the caller as `Result.err(error)` and the upload becomes `failed` with `lastError` set. The session hooks are not consulted, the session mode does not change, and nothing is retried automatically: the caller decides what to do, and calling `resolveOfflineUpload(s)` again runs the upload again. To let the session classify the failure (and possibly enter offline mode), pass the error to `storeManager.reportOfflineFailure(error)`; see [Failures of the app's own requests](#failures-of-the-apps-own-requests).

#### Upload states

- `pending` - staged and waiting to be uploaded, including uploads waiting for an automatic retry (those have `lastError` set).
- `uploading` - the transport is running.
- `uploaded` - the transport returned the final ref (`resolvedRef`).
- `failed` - the last attempt failed and TSDF will not retry on its own. A `failed` upload is never blocked: it is uploaded again the next time an operation that depends on it is replayed or runs directly, or `resolveOfflineUpload(s)` is called for it.

Queued mutations and staged uploads live in browser storage (localStorage, IndexedDB, OPFS), which the browser may evict under storage pressure unless the origin was granted persistent storage. TSDF does not request it: `navigator.storage.persist()` is an origin-wide permission and some browsers prompt for it, so the app should call it at a moment of its choosing (for example when the first change is queued).
