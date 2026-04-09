# Real-Time Updates

TSDF has built-in support for real-time data sources like WebSockets or Server-Sent Events. When enabled, stores adjust their fetch behavior to work with push-based data.

## Enabling Real-Time Mode

```ts
const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  errorNormalizer: normalizeError,
});

const store = createDocumentStore<Data>({
  id: 'document-data',
  storeManager,
  usesRealTimeUpdates: true,
  dynamicRealtimeThrottleMs: ({ lastFetchDuration, windowIsNotFocused }) => {
    if (windowIsNotFocused) return lastFetchDuration * 10;
    return lastFetchDuration * 2;
  },
  // ...other options
});
```

## Behavior Changes

When `usesRealTimeUpdates: true`:

| Behavior                    | Change                                                         |
| --------------------------- | -------------------------------------------------------------- |
| `disableRefetchOnMount`     | Defaults to `true` globally (data comes via push, not polling) |
| `revalidateOnWindowFocus`   | Disabled (real-time transport handles freshness)               |
| `realtimeUpdate` fetch type | Enabled for use with the scheduler                             |

## Pushing Updates

When your real-time transport receives new data, update the store directly:

```ts
// Document Store
websocket.on('user-updated', (newData) => {
  store.updateState((draft) => {
    Object.assign(draft, newData);
  });
});

// Collection Store
websocket.on('product-updated', ({ productId, data }) => {
  store.updateItemState(productId, (draft) => {
    Object.assign(draft, data);
  });
});

// List Query Store
websocket.on('task-updated', ({ taskId, data }) => {
  store.updateItemState(taskId, (draft) => {
    Object.assign(draft, data);
  });
});
```

If the pushed data is partial, you can invalidate instead:

```ts
websocket.on('task-changed', ({ taskId }) => {
  // Collection Store
  store.invalidateItem(taskId, 'realtimeUpdate');

  // List Query Store
  store.invalidateQueryAndItems({
    itemPayload: taskId,
    queryPayload: () => true,
    type: 'realtimeUpdate',
  });
});
```

## Adaptive Throttling

The `dynamicRealtimeThrottleMs` function controls how often real-time invalidations trigger actual fetches. It receives the duration of the last fetch and whether the window is focused:

```ts
dynamicRealtimeThrottleMs: ({ lastFetchDuration, windowIsNotFocused }) => {
  // If fetch took 200ms, wait at least 400ms before the next one
  // If window is not focused, wait 10x longer
  if (windowIsNotFocused) return lastFetchDuration * 10;
  return lastFetchDuration * 2;
};
```

This prevents the UI from being overwhelmed by rapid updates while keeping data fresh.

## Transport Reconnection

When your WebSocket or SSE connection drops and reconnects, events may have been missed. Call `onTransportReconnect()` to revalidate:

```ts
websocket.on('reconnect', () => {
  store.onTransportReconnect();
});
```

Behavior:

- If the window is **focused**: all data is invalidated immediately with `realtimeUpdate` priority
- If the window is **not focused**: invalidation is deferred until the window regains focus
- Multiple reconnect calls while unfocused are coalesced (only one invalidation fires on focus)
- This is a no-op when `usesRealTimeUpdates` is `false`

## Pattern: WebSocket Integration

```ts
const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  errorNormalizer: normalizeError,
});

const taskStore = createListQueryStore<Task, TaskFilter, string>({
  id: 'tasks',
  storeManager,
  fetchListFn: (filter, size, { signal }) => api.getTasks(filter, size, signal),
  fetchItemFn: (taskId, { signal }) => api.getTask(taskId, signal),
  usesRealTimeUpdates: true,
  dynamicRealtimeThrottleMs: ({ lastFetchDuration, windowIsNotFocused }) => {
    if (windowIsNotFocused) return 30_000;
    return Math.max(lastFetchDuration * 2, 1000);
  },
  // ...other options
});

// Connect WebSocket
const ws = connectWebSocket('/tasks');

ws.on('task:created', ({ task, taskId }) => {
  taskStore.addItemToState(taskId, task, {
    addItemToQueries: {
      queries: (query) => query.projectId === task.projectId,
      appendTo: 'start',
    },
  });
});

ws.on('task:updated', ({ taskId, changes }) => {
  taskStore.updateItemState(taskId, (draft) => {
    Object.assign(draft, changes);
  });
});

ws.on('task:deleted', ({ taskId }) => {
  taskStore.deleteItemState(taskId);
});

ws.on('reconnect', () => {
  taskStore.onTransportReconnect();
});
```
