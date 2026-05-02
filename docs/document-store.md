# Document Store

A store for managing a single entity/document. It provides one fetch function and maintains a single piece of data with loading states, error handling, and automatic refetching.

See also: [Hooks](./hooks.md) | [Mutations](./mutations.md) | [Invalidation](./invalidation.md) | [Fetch Scheduling](./fetch-scheduling.md) | [Persistent Storage](./persistent-storage.md) | [Offline](./offline.md)

## Creating a Document Store

```ts
import { createDocumentStore, createStoreManager } from 'tsdf';

type User = { id: string; name: string; email: string };
const storeManager = createStoreManager({
  getSessionKey: () =>
    authState.userId ? `tenant:${authState.tenantId}` : false,
  errorNormalizer: normalizeError,
});

const userStore = createDocumentStore<User>({
  id: 'document-user',
  storeManager,
  fetchFn: (signal) => api.getUser(signal),
  lowPriorityThrottleMs: 2000,
  baseCoalescingWindowMs: 100,
  blockWindowClose: null,
});
```

## Options

| Option                         | Type                                                                             | Required | Description                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `id`                           | `string`                                                                         | Yes      | Stable logical store id for [Browser Tabs Sync](./browser-tabs-sync.md)                 |
| `storeManager`                 | `StoreManager`                                                                   | Yes      | Shared global config with `getSessionKey`, `errorNormalizer`, and global store controls |
| `fetchFn`                      | `(signal: AbortSignal) => Promise<State>`                                        | Yes      | Fetches the document data                                                               |
| `lowPriorityThrottleMs`        | `number`                                                                         | Yes      | See [Fetch Scheduling](./fetch-scheduling.md)                                           |
| `baseCoalescingWindowMs`       | `number`                                                                         | Yes      | See [Fetch Scheduling](./fetch-scheduling.md)                                           |
| `blockWindowClose`             | `BlockWindowCloseHandler \| null`                                                | Yes      | See [Mutations](./mutations.md)                                                         |
| `debugName`                    | `string`                                                                         | No       | Debug name for logging                                                                  |
| `dynamicRealtimeThrottleMs`    | `(params: { lastFetchDuration: number; windowIsNotFocused: boolean }) => number` | No       | See [Real-Time Updates](./real-time-updates.md)                                         |
| `revalidateOnWindowFocus`      | `boolean \| (() => boolean)`                                                     | No       | Refetch on window focus                                                                 |
| `transportReconnectCooldownMs` | `number`                                                                         | No       | Cooldown for repeated transport reconnect revalidation                                  |
| `mediumPriorityDelayMs`        | `number`                                                                         | No       | Delay for medium-priority fetches                                                       |
| `usesRealTimeUpdates`          | `boolean`                                                                        | No       | Enables [Real-Time Updates](./real-time-updates.md) mode                                |
| `persistentStorage`            | `DocumentPersistentStorageConfig<State>`                                         | No       | Configure cache persistence. See [Persistent Storage](./persistent-storage.md)          |
| `onSchedulerEvent`             | `(event) => void`                                                                | No       | Scheduler event listener                                                                |
| `onMutationError`              | `(error, options: { dontShowToast?: boolean }) => void`                          | No       | Global mutation error handler                                                           |

## State Shape

```ts
type DocumentStoreState<State> = {
  data: State | null;
  error: StoreError | null;
  status: 'idle' | 'loading' | 'error' | 'refetching' | 'success';
  refetchOnMount:
    | false
    | 'lowPriority'
    | 'mediumPriority'
    | 'realtimeUpdate'
    | 'highPriority';
};
```

- `data` starts as `null` and is populated after a successful fetch
- `status` transitions: `idle` -> `loading` -> `success` / `error`; on refetch: `success` -> `refetching` -> `success` / `error`
- `refetchOnMount` is set by [invalidation](./invalidation.md) to trigger a refetch on next hook mount

## API

### Hooks

| Hook                            | Description                           | Details                                                       |
| ------------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| `useDocument(options?)`         | Primary data hook                     | See [Hooks - useDocument](./hooks.md#usedocument)             |
| `useListItemIsLoading(options)` | Detect if a sub-item is loading       | See [Hooks - useListItem Hooks](./hooks.md#uselistitem-hooks) |
| `useListItemIsDeleted(options)` | Detect if a sub-item was deleted      | See [Hooks - useListItem Hooks](./hooks.md#uselistitem-hooks) |
| `useListItem(options)`          | Combined loading + deletion detection | See [Hooks - useListItem Hooks](./hooks.md#uselistitem-hooks) |

### Methods

| Method                     | Signature                                       | Description                                                     |
| -------------------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| `scheduleFetch`            | `(fetchType, options?) => ScheduleFetchResults` | Schedule a fetch. See [Fetch Scheduling](./fetch-scheduling.md) |
| `awaitFetch`               | `(options?) => Promise<{ data, error }>`        | Await a fetch with optional `timeoutMs`                         |
| `preloadPersistentStorage` | `() => Promise<void>`                           | Preload cached document data from async storage (OPFS)          |
| `invalidateData`           | `(priority?) => void`                           | Invalidate data. See [Invalidation](./invalidation.md)          |
| `updateState`              | `(produceFn) => boolean`                        | Immer-based state update. Returns `false` if no data exists     |
| `reset`                    | `() => void`                                    | Reset store to idle state                                       |
| `startMutation`            | `() => () => boolean`                           | Manually start a mutation lock. See [Mutations](./mutations.md) |
| `performMutation`          | `(options) => Promise<Result<T>>`               | Full mutation lifecycle. See [Mutations](./mutations.md)        |
| `onTransportReconnect`     | `() => void`                                    | See [Real-Time Updates](./real-time-updates.md)                 |

### Offline Methods

| Method                                                | Description                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| `getOfflineEntities()` / `useOfflineEntities()`       | Read offline entities scoped to this store                        |
| `getOfflineResolutions()` / `useOfflineResolutions()` | Read manual conflict/retry resolutions scoped to this store       |
| `parseOfflineResolutionConflict(resolution)`          | Narrow a persisted resolution to this store's operation types     |
| `resolveOfflineResolution(id, operation, action)`     | Resolve, retry, discard, requeue, or commit an offline resolution |

### Properties

| Property      | Type                                | Description                                                |
| ------------- | ----------------------------------- | ---------------------------------------------------------- |
| `store`       | `Store<DocumentStoreState<State>>`  | Underlying t-state store                                   |
| `events`      | `Emitter`                           | Invalidation events                                        |
| `storeEvents` | `Emitter<DocumentStoreStoreEvents>` | Mutation lifecycle events (`mutationStart`, `mutationEnd`) |

## Usage Example

```tsx
const storeManager = createStoreManager({
  getSessionKey: () =>
    authState.userId ? `tenant:${authState.tenantId}` : false,
  errorNormalizer: normalizeError,
});

const settingsStore = createDocumentStore<AppSettings>({
  id: 'document-settings',
  storeManager,
  fetchFn: (signal) => api.getSettings(signal),
  lowPriorityThrottleMs: 5000,
  baseCoalescingWindowMs: 200,
  revalidateOnWindowFocus: true,
  blockWindowClose: null,
});

function Settings() {
  const { data, isLoading, error } = settingsStore.useDocument();

  if (isLoading) return <Spinner />;
  if (error) return <Error error={error} />;

  return <SettingsForm data={data} />;
}

// Update state locally (immer-based)
settingsStore.updateState((draft) => {
  draft.theme = 'dark';
});

// Invalidate to trigger refetch
settingsStore.invalidateData();
```
