# TSDF Documentation

TSDF (TypeScript Data Fetching) is a data fetching and caching library for React, built on [t-state](https://github.com/lucasols/t-state). It manages server data with automatic fetching, caching, invalidation, optimistic updates, and real-time update support.

## Store Types

TSDF provides three store types for different data patterns:

| Store                                     | Use case                       | Key characteristics                              |
| ----------------------------------------- | ------------------------------ | ------------------------------------------------ |
| [Document Store](./document-store.md)     | Single entity/document         | One fetch function, one piece of data            |
| [Collection Store](./collection-store.md) | Key-value collection of items  | Each item fetched independently by payload       |
| [List Query Store](./list-query-store.md) | Paginated lists + item queries | Items shared across queries, supports pagination |

## Features

| Feature                                                 | Applicable stores      | Description                                                                |
| ------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| [React Hooks](./hooks.md)                               | All                    | `useDocument`, `useItem`, `useListQuery`, and more                         |
| [Store Manager](./store-manager.md)                     | All                    | Session scoping, global resets, shared offline runtime state               |
| [Fetch Scheduling](./fetch-scheduling.md)               | All                    | Priority levels, throttling, coalescing, and batching                      |
| [Browser Tabs Sync](./browser-tabs-sync.md)             | All                    | Cross-tab fetch deduplication and snapshot synchronization                 |
| [Mutations](./mutations.md)                             | All                    | Data mutations with optimistic updates and revalidation                    |
| [Invalidation](./invalidation.md)                       | All                    | Mark data as stale and trigger refetches                                   |
| [Batch Fetching](./batch-fetching.md)                   | Collection, List Query | Fetch multiple items in a single request                                   |
| [Cache Limits](./cache-limits.md)                       | Collection, List Query | Bound in-memory item/query caches with LRU eviction                        |
| [Real-Time Updates](./real-time-updates.md)             | All                    | WebSocket/SSE integration with adaptive throttling                         |
| [Persistent Storage](./persistent-storage.md)           | All                    | Restore cached data from localStorage, IndexedDB, or OPFS between sessions |
| [Offline](./offline.md)                                 | All                    | Durable mutation queueing, replay, conflicts, temp entities, and uploads   |
| [Optimistic List Updates](./optimistic-list-updates.md) | List Query             | Auto-sort/filter queries when item state changes                           |
| [Partial Resources](./partial-resources.md)             | List Query             | Fetch only specific fields, with per-field invalidation                    |
| [Offset Pagination](./offset-pagination.md)             | List Query             | Offset/limit-based pagination with chunked invalidation                    |
| [Shared Types](./shared-types.md)                       | All                    | Common types/utilities (`StoreError`, `IsOffScreenContext`, priorities)    |

Notable additions:

- Hook payload debouncing is documented in [React Hooks](./hooks.md#debouncepayload)
- The exported `PayloadDebounce` type is documented in [Shared Types](./shared-types.md#payloaddebounce)
- `GET_ALL` and `{ all: true }` invalidation are documented in [Invalidation](./invalidation.md#list-query-store)

## Quick Start

```tsx
import { createDocumentStore, createStoreManager } from 'tsdf';

const storeManager = createStoreManager({
  getSessionKey: () => (auth.userId ? `tenant:${auth.tenantId}` : false),
  errorNormalizer: (err) => ({
    code: 500,
    id: 'fetch-error',
    message: err.message,
  }),
  lowPriorityThrottleMs: 5,
  baseCoalescingWindowMs: 10,
  blockWindowClose: null,
  revalidateOnWindowFocus: true,
  onMutationError: (error) => {
    console.error('TSDF mutation failed', error);
  },
  onPersistentStorageError: (error) => {
    console.error('TSDF persistence failed', error);
  },
});

const userStore = createDocumentStore<User>({
  id: 'document-user',
  storeManager,
  fetchFn: (signal) => fetch('/api/user', { signal }).then((r) => r.json()),
});

function UserProfile() {
  const { data, status, isLoading } = userStore.useDocument();

  if (isLoading) return <Loading />;
  if (!data) return null;

  return <div>{data.name}</div>;
}
```

## Common Options

All three store types share these creation options:

| Option                         | Type                                                                                                                      | Required | Description                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `storeManager`                 | `StoreManager`                                                                                                            | Yes      | Shared global config with session scoping, store defaults, and global store controls                                   |
| `lowPriorityThrottleMs`        | `number`                                                                                                                  | No       | Overrides the manager default minimum interval between low-priority fetches                                            |
| `baseCoalescingWindowMs`       | `number`                                                                                                                  | No       | Overrides the manager default window to group multiple fetch requests into a batch                                     |
| `mediumPriorityDelayMs`        | `number`                                                                                                                  | No       | Delay before medium-priority fetches execute                                                                           |
| `dynamicRealtimeThrottleMs`    | `(params) => number`                                                                                                      | No       | Dynamic throttle for [real-time updates](./real-time-updates.md)                                                       |
| `revalidateOnWindowFocus`      | `boolean \| (() => boolean)`                                                                                              | No       | Overrides the manager default for refetching data when window regains focus. Use `false` to disable                    |
| `transportReconnectCooldownMs` | `number`                                                                                                                  | No       | Cooldown for repeated transport reconnect revalidation                                                                 |
| `persistentStorage`            | `DocumentPersistentStorageConfig<...> \| CollectionPersistentStorageConfig<...> \| ListQueryPersistentStorageConfig<...>` | No       | Configure cache persistence and optional session-based offline behavior                                                |
| `usesRealTimeUpdates`          | `boolean`                                                                                                                 | No       | Enables [real-time update mode](./real-time-updates.md)                                                                |
| `onSchedulerEvent`             | `(event) => void`                                                                                                         | No       | Callback for [scheduler events](./fetch-scheduling.md)                                                                 |
| `onMutationError`              | `(error, options) => void \| null`                                                                                        | No       | Store-specific handler for [mutation](./mutations.md) errors. Overrides the manager fallback; use `null` to disable it |
| `id`                           | `string`                                                                                                                  | Yes      | Stable logical store id used for debug labels, persistence namespaces, and [Browser Tabs Sync](./browser-tabs-sync.md) |
