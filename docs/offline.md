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
- Queued operations only persist upload ids. Their refs are resolved when the operation replays, so they are covered by the same validation.
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
- Because it is read back from storage, it is typed as an unvalidated `ValidPayload`: parse it with a schema before using it, as above. Uploads staged without metadata (including the ones persisted by older versions) reach the transport with `metadata: undefined`.
- `saveOfflineUpload` stores exactly the metadata it receives. `replaceOfflineUpload` keeps the metadata already saved for that id unless new `metadata` is passed.
- Custom `OfflineUploadAdapter` implementations must persist and restore the record's `metadata` field together with the rest of the record.
