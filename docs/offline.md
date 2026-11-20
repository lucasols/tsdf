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
- `useOfflineUploadFile(id)` — see [Rendering staged files](#rendering-staged-files)

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

- `status` — `idle` (falsy id), `loading`, `success`, `missing` (no upload with this id is staged in the active session) or `error` (the upload adapter failed to read the file)
- `url` — object URL of the staged file, managed by TSDF. Only set on `success`
- `file` — the staged `File`, for reading its contents. Only set on `success`
- `error` — the read failure. Only set on `error`

Caching and URL lifetime:

- Components using the same id share one read and one object URL, so the hook can be called from as many components as needed.
- A staged file the session already holds is returned on the first render, with no `loading` state. `loading` only shows while the session is still restoring its uploads (right after a reload) or reading an upload it does not hold yet.
- The URL exists while at least one component uses the id. It is revoked about one second after the last one stops using it (unmount or falsy id), so remounts and React StrictMode keep the same URL.
- `replaceOfflineUpload` gives every consumer a new `url` / `file` and revokes the previous URL.
- When the upload leaves the session (`deleteOfflineUpload`, retention expiry, or a mutation-attached file being consumed) the status becomes `missing` and the URL is revoked. Staging the same id again makes it available again.
- Use `url` directly in render (`<img src>`, `<a href>`). Do not revoke it, do not keep it outside of render, and do not create extra object URLs from `file`.

The file follows the upload record, not its upload state: it stays available while the upload is `pending`, `uploading` and `uploaded`. To move from the local file to the uploaded one without a gap, derive the id from the entity as in the example above:

- Uploads staged with `saveOfflineUpload` are kept (state `uploaded`) after the mutation depending on them replays, until `deleteOfflineUpload` or retention removes them. The local file therefore stays renderable until `onSuccessExecute` writes the server ref into the entity; from that render on the component passes a falsy id and renders the server file.
- Files attached with `performMutation({ upload })` are removed once their mutation replayed, which happens after `onSuccessExecute` ran, so the entity already holds the server data when the hook reports `missing`.

A local ref paired with `missing` therefore means the staged file was deleted or expired, not that it is about to appear.
