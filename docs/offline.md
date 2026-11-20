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
- `kind` - `create`, `update`, or `delete`; TSDF derives each affected entity's lifecycle from this.
- `execute(ctx)` - Sends queued work to the server during replay.

Collection and list-query operations also define:

- `getEntityRefs({ input })` - Returns affected item/entity refs.
- `dependsOn({ input })` - Optional dependencies on other offline entities of the same store.
- `cancelledWith({ input })` - Optional entities of other stores whose cancelled creation also drops this work. See [Deleting entities created offline](#deleting-entities-created-offline).

Optional replay behavior:

- `onSuccessExecute(ctx)` - Updates live store state after replay succeeds.
- `getServerSnapshot(ctx)` - Loads fresh server state before replay checks.
- `shouldSkipSync(ctx)` - Drops queued work when the server already reflects it.
- `conflictHandling` - Detects conflicts and creates manual resolution records.
- `accumulation` - Merges newer queued inputs into an existing queued mutation.
- `supersedes` - Prunes older queued work for the same entity.

Create flows for collection and list-query stores can use `tempEntity` or `tempEntities` to insert optimistic entities with temporary payloads and reconcile them to final server payloads after replay. Document stores do not support temp entities.

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

- **Never sent** (still waiting in the queue): nothing is sent. TSDF drops the creation, the queued edits of the entity, the delete itself and the queued work that depends on the entity (`dependsOn`), then removes the temporary entity from the store and its lists.
- **Sent** (`syncing`, `needs-confirmation`, or queued again after a `retry`): the server may have the entity, so the creation is kept and the delete stays queued behind it. Once the server id is known the delete is sent with it. `execute` should treat a not-found answer as success, as above: the server answers not-found when the creation never reached it, or when an earlier delete attempt did.
- **Waiting for a manual resolution**: the creation is kept too, and the delete is held behind that resolution. See [Entities whose creation waits for a resolution](#entities-whose-creation-waits-for-a-resolution).

`getItemOfflineState(payload)` tells the first case apart before deleting: `isUnsentCreation && !creationAttempted` means the delete only discards local work.

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

When the creation of that task is cancelled as above, or its manual resolution is discarded, the queued comments are dropped with it and their temporary entities are removed. `cancelledWith` only drives this cleanup: it does not delay replay or rewrite the input when the task gets its server id, and it only reaches stores that are instantiated when the cancellation happens.

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

- `discard` - Drop the resolution record. The optimistic changes of the discarded mutation cannot be rolled back locally, so TSDF refetches what the operation referenced (`getEntityRefs`): the document, the collection item, or the list query item together with the store's lists (the change may have moved or removed the row). An entity that other changes still wait for a decision on is not refetched, since the refetch would replace those changes: it is revalidated once the last one is handled. Likewise, while other changes of a list query store still wait for a manual resolution, only the item is refetched: its lists are revalidated once the last one is handled. Discarding a temp create removes the temp entity and everything queued on top of it; existing entities changed on top of it are refetched.
- `requeue` - Queue replacement input for an operation conflict.
- `commit` - Accept an externally completed resolution result.
- `retry` - Retry a retry-exhausted record.

A mutation that exhausted its replay retries leaves the queue when it becomes a resolution record, so the mutations queued behind it keep replaying; only the ones that depend on it (queued on top of its temp entity) wait with it.

Use `parseOfflineResolutionConflict(resolution)` to narrow a persisted resolution back to the operation-specific conflict/input type before rendering a manual resolution UI.

### Entities whose creation waits for a resolution

While the creation of an entity made offline waits for a resolution, the server does not know the entity, so nothing else can be sent for it. The mutations that target or depend on it become blocked resolutions behind the creation (`blockedResolutionCount > 0`, error `Blocked by unresolved dependency`), whether they were queued before the creation failed or made afterwards, online or offline. `performMutation(...)` returns `{ kind: 'queued' }` for them and the optimistic update stays visible.

They follow the decision about the creation: `retry` (default scope) sends the creation again and then the blocked mutations with the server id, `discard` drops them with the creation. This includes a delete with `dropSelfIfTempLifecycleCancelled`: the creation may have reached the server, so it is not cancelled locally; the delete is sent after the creation is retried, or dropped when it is discarded.

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

| `code`                   | Meaning                                                                                                                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolution-not-found`   | No resolution with this id in the active session, e.g. it was already resolved or the session is logged out. It is also returned when another tab created the record after this tab's store loaded its resolutions; act on it from the tab that created it or after a reload. |
| `store-not-registered`   | The owning store was not created with this manager (yet). Resolutions are shared by the whole session, including other tabs, so a record can be listed before its store exists here.                                                                                          |
| `retry-not-supported`    | `retry` was requested for a `conflict` record. Conflicts are resolved with `discard`, or with `requeue` / `commit` on the store API.                                                                                                                                          |
| `resolution-blocked`     | The record is blocked by parent resolutions (`blockedByResolutionIds`). Resolve the parents first.                                                                                                                                                                            |
| `offline-not-configured` | The manager was created without `offlineSession`.                                                                                                                                                                                                                             |
| `action-failed`          | The owning store failed while applying the action. The original error is in `error.cause`.                                                                                                                                                                                    |

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

Collection and list-query stores expose `useItemOfflineState(itemPayload)` / `getItemOfflineState(itemPayload)` for per-row UI such as sync badges. They return `null` when the item has nothing queued, otherwise `{ syncState, pendingMutations, requiresResolution, isUnsentCreation, creationAttempted }`:

```tsx
const offlineState = userStore.useItemOfflineState({ id: 1 });
// null | { syncState: 'pending', pendingMutations: 1, requiresResolution: false, isUnsentCreation: false, creationAttempted: false }
```

Prefer it over building a map from `useOfflineEntities()`: a component using the hook re-renders only when the state of its own item changes. `isUnsentCreation` is `true` for an item created offline until the server confirms it; after that the temporary payload returns `null` and the final payload reports the mutations still queued for the item. `creationAttempted` turns `true` once that creation starts being sent: before that, deleting the item only discards local work (see [Deleting entities created offline](#deleting-entities-created-offline)). See [Hooks - useItemOfflineState](./hooks.md#useitemofflinestate).

Document stores hold a single entity, so they do not need a per-item reader: use `useDocument().pendingSync` or `useOfflineEntities()[0]`.

## Runtime Controls

The store manager owns runtime controls for the shared session:

```ts
storeManager.setOfflineRuntimeConfig({ network: { enabled: false } });

storeManager.resetOfflineRuntimeConfig();
```

`getOfflineRuntimeConfig()` returns the current effective controls. Runtime updates are useful for explicit "work offline" toggles, diagnostics, or temporarily disabling queueing modes.

## Uploads

Configure uploads on `offlineSession.uploads` when queued mutations depend on local files. The manager exposes upload helpers:

- `saveOfflineUpload({ id, file, metadata? })`
- `replaceOfflineUpload({ id, file, metadata? })`
- `loadOfflineUpload(id)`
- `deleteOfflineUpload(id)`
- `resolveOfflineUpload(id)`
- `resolveOfflineUploads(ids)`
- `useOfflineUploads()`

Operations can declare `dependsOnUploads({ input })` and then read resolved upload refs from `execute({ uploads })`. `opfsOfflineUploadAdapter` is exported as a built-in OPFS-backed upload adapter.

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
- Custom `OfflineUploadAdapter` implementations must persist and restore the record's `metadata` field together with the rest of the record.
