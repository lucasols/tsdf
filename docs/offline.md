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

- `discard` - Drop the resolution record.
- `requeue` - Queue replacement input for an operation conflict.
- `commit` - Accept an externally completed resolution result.
- `retry` - Retry a retry-exhausted record.

Use `parseOfflineResolutionConflict(resolution)` to narrow a persisted resolution back to the operation-specific conflict/input type before rendering a manual resolution UI.

### Entities whose creation waits for a resolution

While the creation of an entity made offline waits for a resolution, the server does not know the entity, so nothing else can be sent for it. The mutations that target or depend on it become blocked resolutions behind the creation (`blockedResolutionCount > 0`, error `Blocked by unresolved dependency`), whether they were queued before the creation failed or made afterwards, online or offline. `performMutation(...)` returns `{ kind: 'queued' }` for them and the optimistic update stays visible.

They follow the decision about the creation: `retry` (default scope) sends the creation again and then the blocked mutations with the server id, `discard` drops them with the creation. This includes a delete with `dropSelfIfTempLifecycleCancelled`: the creation may have reached the server, so it is not cancelled locally; the delete is sent after the creation is retried, or dropped when it is discarded.

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

- `saveOfflineUpload({ id, file })`
- `replaceOfflineUpload({ id, file })`
- `loadOfflineUpload(id)`
- `deleteOfflineUpload(id)`
- `resolveOfflineUpload(id)`
- `resolveOfflineUploads(ids)`
- `useOfflineUploads()`

Operations can declare `dependsOnUploads({ input })` and then read resolved upload refs from `execute({ uploads })`. `opfsOfflineUploadAdapter` is exported as a built-in OPFS-backed upload adapter.
