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
