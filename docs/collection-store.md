# Collection Store

A store for managing a key-value collection of independently fetched items. Each item is identified by a payload and has its own fetch lifecycle, loading state, and error handling.

See also: [Hooks](./hooks.md) | [Mutations](./mutations.md) | [Invalidation](./invalidation.md) | [Batch Fetching](./batch-fetching.md) | [Cache Limits](./cache-limits.md) | [Persistent Storage](./persistent-storage.md) | [Offline](./offline.md)

## Creating a Collection Store

```ts
import { createCollectionStore, createStoreManager } from 'tsdf';

type Product = { id: string; name: string; price: number };
const storeManager = createStoreManager({
  getSessionKey: () =>
    authState.userId ? `tenant:${authState.tenantId}` : false,
  errorNormalizer: normalizeError,
  lowPriorityThrottleMs: 5,
  baseCoalescingWindowMs: 10,
  blockWindowClose: null,
});

const productStore = createCollectionStore<Product, string>({
  id: 'collection-products',
  storeManager,
  fetchFn: (productId, signal) => api.getProduct(productId, signal),
});
```

## Options

| Option                         | Type                                                                                                                       | Required | Description                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `id`                           | `string`                                                                                                                   | Yes      | Stable logical store id used for debug labels, persistence namespaces, and [Browser Tabs Sync](./browser-tabs-sync.md) |
| `storeManager`                 | `StoreManager`                                                                                                             | Yes      | Shared global config with `getSessionKey`, `errorNormalizer`, and global store controls                                |
| `fetchFn`                      | `(params, signal) => Promise<ItemState \| Result<ItemState, Error>>`                                                       | Yes      | Fetches a single item                                                                                                  |
| `batchFetchFn`                 | `(payloads, signal, batchKey) => Promise<Map<ItemPayload, ItemState \| Error \| Result<ItemState, Error>> \| Result<Map>>` | No       | See [Batch Fetching](./batch-fetching.md)                                                                              |
| `getItemsBatchKey`             | `(payload: ItemPayload) => string \| false`                                                                                | No       | Groups batch fetches by key. `false` falls back to per-item fetch                                                      |
| `maxBatchSize`                 | `number`                                                                                                                   | No       | Triggers immediate fetch when batch reaches this size                                                                  |
| `maxItems`                     | `number`                                                                                                                   | No       | Maximum cached items kept in memory. Defaults to `5000`. See [Cache Limits](./cache-limits.md)                         |
| `onStateCleanup`               | `(cleanup) => void`                                                                                                        | No       | Called when memory cache eviction removes items. See [Cache Limits](./cache-limits.md)                                 |
| `getCollectionItemKey`         | `(params: ItemPayload) => ValidPayload \| unknown[]`                                                                       | No       | Custom key derivation from payload                                                                                     |
| `lowPriorityThrottleMs`        | `number`                                                                                                                   | No       | Overrides the manager default. See [Fetch Scheduling](./fetch-scheduling.md)                                           |
| `baseCoalescingWindowMs`       | `number`                                                                                                                   | No       | Overrides the manager default. See [Fetch Scheduling](./fetch-scheduling.md)                                           |
| `mediumPriorityDelayMs`        | `number`                                                                                                                   | No       | Delay for medium-priority fetches                                                                                      |
| `dynamicRealtimeThrottleMs`    | `(params) => number`                                                                                                       | No       | See [Real-Time Updates](./real-time-updates.md)                                                                        |
| `revalidateOnWindowFocus`      | `boolean \| (() => boolean)`                                                                                               | No       | Refetch on window focus                                                                                                |
| `transportReconnectCooldownMs` | `number`                                                                                                                   | No       | Cooldown for repeated transport reconnect revalidation                                                                 |
| `usesRealTimeUpdates`          | `boolean`                                                                                                                  | No       | See [Real-Time Updates](./real-time-updates.md)                                                                        |
| `persistentStorage`            | `CollectionPersistentStorageConfig<ItemState, ItemPayload>`                                                                | No       | Configure cache persistence. See [Persistent Storage](./persistent-storage.md)                                         |
| `onInvalidate`                 | `(props: { itemState, payload, priority }) => void`                                                                        | No       | Called when an item is invalidated                                                                                     |
| `onSchedulerEvent`             | `(event, data?) => void`                                                                                                   | No       | Scheduler event listener                                                                                               |
| `onMutationError`              | `(error, options: { silentErrors?: boolean }) => void`                                                                     | No       | Global mutation error handler                                                                                          |

Fetch callbacks return promises. The resolved value may be either plain data or a `Result`. `Result.ok(data)` is stored as successful data; `Result.err(error)` is normalized into the item error state.

## Item State Shape

```ts
type TSFDCollectionItem<ItemState, ItemPayload> = {
  data: ItemState | null;
  error: StoreError | null;
  status: 'loading' | 'error' | 'refetching' | 'success';
  payload: ItemPayload;
  refetchOnMount:
    | false
    | 'lowPriority'
    | 'mediumPriority'
    | 'realtimeUpdate'
    | 'highPriority';
  wasLoaded: boolean;
};
```

The overall store state is `Record<string, TSFDCollectionItem | null>` where keys are derived from payloads.

- A `null` value means the item was deleted via `deleteItemState`
- An `undefined` value (key not present) means the item was never fetched

## API

### Hooks

| Hook                                     | Description                           | Details                                                       |
| ---------------------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| `useItem(payload, options?)`             | Fetch and subscribe to a single item  | See [Hooks - useItem](./hooks.md#useitem)                     |
| `useMultipleItems(items, options?)`      | Fetch and subscribe to multiple items | See [Hooks - useMultipleItems](./hooks.md#usemultipleitems)   |
| `useListItemIsLoading(payload, options)` | Detect if a sub-item is loading       | See [Hooks - useListItem Hooks](./hooks.md#uselistitem-hooks) |
| `useListItemIsDeleted(payload, options)` | Detect if a sub-item was deleted      | See [Hooks - useListItem Hooks](./hooks.md#uselistitem-hooks) |
| `useListItem(payload, options)`          | Combined loading + deletion detection | See [Hooks - useListItem Hooks](./hooks.md#uselistitem-hooks) |

### Methods

| Method                    | Signature                                                            | Description                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `scheduleFetch`           | `(fetchType, payload(s), options?) => ScheduleFetchResults`          | Schedule fetch for one or more items                                                                                                            |
| `awaitFetch`              | `(params, options?) => Promise<{ data, error }>`                     | Await fetch with optional `timeoutMs`                                                                                                           |
| `getItemFromStateOrFetch` | `(params, options?) => Promise<Result<ItemState, StoreFetchError>>`  | Return loaded item data or fetch it if missing                                                                                                  |
| `preloadItemFromStorage`  | `(params) => Promise<PersistentStoragePreloadResult<ItemPayload>[]>` | Preload cached item payloads from async storage (OPFS)                                                                                          |
| `getItemKey`              | `(params) => string`                                                 | Get the composite key for a payload                                                                                                             |
| `getItemState`            | `(params) => CollectionItem`                                         | Get item state (single, array, or filter function)                                                                                              |
| `invalidateItem`          | `(payload(s), priority?) => void`                                    | See [Invalidation](./invalidation.md)                                                                                                           |
| `updateItemState`         | `(params, produceFn, options?) => boolean`                           | Immer-based state update                                                                                                                        |
| `addItemToState`          | `(payload, data) => void`                                            | Add a new item to the store                                                                                                                     |
| `deleteItemState`         | `(params) => void`                                                   | Delete item(s) and cleanup scheduler resources                                                                                                  |
| `startMutation`           | `(params) => () => void`                                             | Start mutation lock. See [Mutations](./mutations.md)                                                                                            |
| `performMutation`         | `(payload, options) => Promise<Result<T>>`                           | Full mutation lifecycle. See [Mutations](./mutations.md)                                                                                        |
| `reset`                   | `() => void`                                                         | Reset store and all schedulers                                                                                                                  |
| `dispose`                 | `() => void`                                                         | Release listeners and store-manager registration                                                                                                |
| `onTransportReconnect`    | `() => void`                                                         | Store-level reconnect hook. Prefer `storeManager.onTransportReconnect()` for shared transports. See [Real-Time Updates](./real-time-updates.md) |

### Offline Methods

| Method                                                | Description                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| `getOfflineEntities()` / `useOfflineEntities()`       | Read offline entities scoped to this store                        |
| `getOfflineResolutions()` / `useOfflineResolutions()` | Read manual conflict/retry resolutions scoped to this store       |
| `parseOfflineResolutionConflict(resolution)`          | Narrow a persisted resolution to this store's operation types     |
| `resolveOfflineResolution(id, operation, action)`     | Resolve, retry, discard, requeue, or commit an offline resolution |

### Payload Overloads

Many methods accept payloads in multiple forms:

```ts
// Single item
store.invalidateItem('product-1');

// Array of items
store.invalidateItem(['product-1', 'product-2']);

// Filter function
store.invalidateItem((payload, data) => data?.category === 'electronics');
```

This applies to: `invalidateItem`, `getItemState`, `updateItemState`, `deleteItemState`, `startMutation`, `scheduleFetch`.

## Usage Example

```tsx
function ProductCard({ productId }: { productId: string }) {
  const { data, isLoading, error } = productStore.useItem(productId);

  if (isLoading) return <Skeleton />;
  if (error) return <Error error={error} />;

  return (
    <div>
      {data?.name} - ${data?.price}
    </div>
  );
}

// Disable fetching with falsy payload
function MaybeProduct({ productId }: { productId: string | null }) {
  const { data, status } = productStore.useItem(productId); // disabled when null
  // ...
}

// Update item state locally
productStore.updateItemState('product-1', (draft) => {
  draft.price = 29.99;
});

// Add a new item
productStore.addItemToState('product-new', {
  id: 'product-new',
  name: 'New',
  price: 0,
});

// Delete an item
productStore.deleteItemState('product-old');
```
