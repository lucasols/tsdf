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

| Feature                                                 | Applicable stores      | Description                                                          |
| ------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| [React Hooks](./hooks.md)                               | All                    | `useDocument`, `useItem`, `useListQuery`, and more                   |
| [Fetch Scheduling](./fetch-scheduling.md)               | All                    | Priority levels, throttling, coalescing, and batching                |
| [Browser Tabs Sync](./browser-tabs-sync.md)             | All                    | Cross-tab fetch deduplication and snapshot synchronization           |
| [Mutations](./mutations.md)                             | All                    | Data mutations with optimistic updates and revalidation              |
| [Invalidation](./invalidation.md)                       | All                    | Mark data as stale and trigger refetches                             |
| [Batch Fetching](./batch-fetching.md)                   | Collection, List Query | Fetch multiple items in a single request                             |
| [Real-Time Updates](./real-time-updates.md)             | All                    | WebSocket/SSE integration with adaptive throttling                   |
| [Persistent Storage](./persistent-storage.md)           | All                    | Restore cached data from localStorage or OPFS between sessions       |
| [Optimistic List Updates](./optimistic-list-updates.md) | List Query             | Auto-sort/filter queries when item state changes                     |
| [Partial Resources](./partial-resources.md)             | List Query             | Fetch only specific fields, with per-field invalidation              |
| [Offset Pagination](./offset-pagination.md)             | List Query             | Offset/limit-based pagination with chunked invalidation              |
| [Shared Types](./shared-types.md)                       | All                    | Common types (`StoreError`, `FetchType`, `IsOffScreenContext`, etc.) |

Notable additions:

- Hook payload debouncing is documented in [React Hooks](./hooks.md#debouncepayload)
- The exported `PayloadDebounce` type is documented in [Shared Types](./shared-types.md#payloaddebounce)

## Quick Start

```tsx
import { createDocumentStore } from 'tsdf';

const userStore = createDocumentStore<User>({
  fetchFn: (signal) => fetch('/api/user', { signal }).then((r) => r.json()),
  errorNormalizer: (err) => ({
    code: 500,
    id: 'fetch-error',
    message: err.message,
  }),
  lowPriorityThrottleMs: 2000,
  baseCoalescingWindowMs: 100,
  backgroundCoalescingWindowMultiplier: 3,
  blockWindowClose: null,
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

| Option                                 | Type                                                                                                                      | Required | Description                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `debugName`                            | `string`                                                                                                                  | No       | Debug name for the store                                                |
| `errorNormalizer`                      | `(exception: Error) => StoreError`                                                                                        | Yes      | Normalizes raw exceptions into `StoreError`                             |
| `lowPriorityThrottleMs`                | `number`                                                                                                                  | Yes      | Minimum interval between low-priority fetches                           |
| `baseCoalescingWindowMs`               | `number`                                                                                                                  | Yes      | Window to group multiple fetch requests into a batch                    |
| `backgroundCoalescingWindowMultiplier` | `number`                                                                                                                  | Yes      | Multiplier for coalescing window when tab is in background              |
| `mediumPriorityDelayMs`                | `number`                                                                                                                  | No       | Delay before medium-priority fetches execute                            |
| `dynamicRealtimeThrottleMs`            | `(params) => number`                                                                                                      | No       | Dynamic throttle for [real-time updates](./real-time-updates.md)        |
| `revalidateOnWindowFocus`              | `boolean \| (() => boolean)`                                                                                              | No       | Refetch data when window regains focus                                  |
| `persistentStorage`                    | `DocumentPersistentStorageConfig<...> \| CollectionPersistentStorageConfig<...> \| ListQueryPersistentStorageConfig<...>` | No       | Configure cache persistence and optional session-based offline behavior |
| `blockWindowClose`                     | `BlockWindowCloseHandler \| null`                                                                                         | Yes      | Blocks window close during [mutations](./mutations.md)                  |
| `usesRealTimeUpdates`                  | `boolean`                                                                                                                 | No       | Enables [real-time update mode](./real-time-updates.md)                 |
| `onSchedulerEvent`                     | `(event) => void`                                                                                                         | No       | Callback for [scheduler events](./fetch-scheduling.md)                  |
| `onMutationError`                      | `(error, options) => void`                                                                                                | No       | Global handler for [mutation](./mutations.md) errors                    |
| `id`                                   | `string`                                                                                                                  | Yes      | Stable logical store id for [Browser Tabs Sync](./browser-tabs-sync.md) |
| `getSessionKey`                        | `() => string \| false`                                                                                                   | Yes      | Session/tenant key for [Browser Tabs Sync](./browser-tabs-sync.md)      |
