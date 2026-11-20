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

- `discard` - Drop the resolution record. The optimistic changes of the discarded mutation cannot be rolled back locally, so TSDF refetches what the operation referenced (`getEntityRefs`): the document, the collection item, or the list query item together with the store's lists (the change may have moved or removed the row). An entity that other changes still wait for a decision on is not refetched, since the refetch would replace those changes: it is revalidated once the last one is handled. Likewise, while other changes of a list query store still wait for a manual resolution, only the item is refetched: its lists are revalidated once the last one is handled. Discarding a temp create removes the temp entity and everything queued on top of it; existing entities changed on top of it are refetched.
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
- Custom `OfflineUploadAdapter` implementations must persist and restore the record's `metadata` field together with the rest of the record.

### Upload lifecycle

A staged upload follows the queued work that depends on it:

- While a queue entry or resolution record declares the upload through `dependsOnUploads`, the upload is kept. This includes a failed mutation waiting for a manual resolution, so `retry` still finds the file. `deleteOfflineUpload(id)` returns an error for an upload in this state.
- When the last queue entry or resolution record that declares it leaves the queue, TSDF deletes the upload (its record and the stored file). It does not matter how the work ended:
  - it replayed successfully, or `shouldSkipSync` dropped it;
  - its resolution was discarded, together with the queued work discarded with it (the edits of an entity whose create was discarded);
  - a later operation pruned it with `supersedes`, or cancelled it with its temp entity (`dropSelfIfTempLifecycleCancelled`);
  - its conflict was resolved with `commit`, or with a `requeue` whose replacement input no longer declares the upload. Uploads the replacement input still declares are kept.
- References are session-wide. An upload declared by queued mutations of several stores is deleted only after the last of them is gone. Only stores created in the current app session count: after a restart, an upload shared with a store that was not created yet can be deleted when the stores already created release it, and that store's queued mutation then fails to replay. If an upload id is shared across lazily created stores, create those stores before their queued work replays, or stage a separate upload for each store.
- An upload that no queued work declared yet is never deleted for being unreferenced: the app stages the file first and queues the mutation afterwards. It stays until a mutation that declares it is queued and leaves the queue, until the app calls `deleteOfflineUpload(id)`, or until it expires. Unreferenced uploads expire after the session has been online for one week without interruption (going offline restarts the window). This also applies to uploads the app resolves itself with `resolveOfflineUpload(s)` for an online mutation, because they never enter the queue.

After an upload that was already sent is deleted, its id keeps resolving to the same server ref for the rest of the app session: a mutation queued later that still declares it (for example from optimistic or draft data that was not updated with the server ref yet) replays with that ref without uploading again, and `resolveOfflineUpload(id)` returns it. This ref is kept in memory only: after a reload, or after `deleteOfflineUpload(id)`, the id is unknown again, so stage the file again with `saveOfflineUpload` before reusing it. Uploads deleted before they were sent (discarded, superseded or cancelled work) are not kept.

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
