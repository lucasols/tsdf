# Mutations

TSDF provides a structured mutation lifecycle that coordinates with the fetch scheduler to prevent conflicts, supports optimistic updates, and handles error recovery with automatic revalidation.

See also: [Offline](./offline.md) for durable offline queueing and replay.

## performMutation

The primary way to perform mutations. Available on all store types.

### Document Store

```ts
const result = await store.performMutation({
  // Optional: update state optimistically before the mutation executes
  optimisticUpdate: (currentState) => {
    if (!currentState) return;
    currentState.name = 'New Name'; // immer-style draft mutation
  },

  // The actual mutation
  mutation: ({ updateState, currentState }) => {
    return api.updateUser({ name: 'New Name' });
  },

  // After success, invalidate data to refetch from the server
  revalidateOnSuccess: true,
});

if (result.ok) {
  console.log('Success:', result.value);
} else {
  console.log('Error:', result.error);
}
```

The `mutation` callback receives:

- `updateState` - An immer-based function to update state during the mutation
- `currentState` - The current data at the time the mutation executes

### Collection Store

```ts
const result = await store.performMutation('item-id', {
  optimisticUpdate: (payload) => {
    store.updateItemState(payload, (draft) => {
      draft.name = 'Updated';
    });
  },
  mutation: (payload) => api.updateItem(payload, { name: 'Updated' }),
  revalidateOnSuccess: true,
});
```

### List Query Store

```ts
const result = await store.performMutation('item-id', {
  optimisticUpdate: (payload) => {
    store.updateItemState(payload, (draft) => {
      draft.status = 'done';
    });
  },
  mutation: (payload) => api.updateTask(payload, { status: 'done' }),
  revalidateOnSuccess: true,
});
```

The payload can be:

- A single item payload
- An array of item payloads
- A filter function `(payload, data) => boolean`
- `null` or `undefined` (matches all items)

## Mutation Lifecycle

1. **Lock**: The scheduler is locked for the affected items/queries, preventing concurrent fetches
2. **Optimistic update**: If provided, runs immediately. If it returns `false`, the mutation is cancelled
3. **Debounce** (optional): Waits for `ms` milliseconds. During debounce, the window close is blocked
4. **Execute mutation**: The async mutation function runs
5. **On success**: Calls `onSuccess`, optionally invalidates data
6. **On error**: Reverts to server state by invalidating, normalizes the error, calls `onMutationError`
7. **Unlock**: The scheduler is unlocked, pending fetches resume

## Return Value

`performMutation` returns a `Result<T, StoreMutationError | MutationSkipped>`:

```ts
const result = await store.performMutation(/* ... */);

if (result.ok) {
  // result.value is the mutation return value
} else {
  if (result.error.kind === 'skipped') {
    // optimisticUpdate returned false, or this call was skipped by debounce
  } else {
    // result.error is a StoreMutationError with code/id/message and cause
  }
}
```

When a mutation uses the `offline` option, the success value is `OfflineMutationResult<T>`:

- `{ kind: 'online', data }` when the direct mutation completed.
- `{ kind: 'queued' }` when TSDF persisted the mutation for offline replay.

## Optimistic Updates

Optimistic updates let you update the UI immediately before the server responds.

```ts
await store.performMutation('item-id', {
  optimisticUpdate: () => {
    // Update the store directly — the UI updates immediately
    store.updateItemState('item-id', (draft) => {
      draft.completed = true;
    });
  },
  mutation: () => api.completeItem('item-id'),
});
```

If the mutation **fails**, TSDF automatically invalidates the data, causing a refetch that reverts the optimistic update to the server's actual state.

### Cancelling a Mutation

Return `false` from `optimisticUpdate` to cancel the mutation entirely.
The returned `Result` will be `Err({ kind: 'skipped' })` rather than a thrown or normalized error:

```ts
optimisticUpdate: (currentState) => {
  if (currentState?.locked) return false; // cancel mutation
  currentState.name = 'Updated';
};
```

## Debouncing

For frequent mutations (e.g., typing), use debounce to batch them:

```ts
await store.performMutation({
  debounce: {
    context: 'update-name', // debounce key
    payload: newName, // only the latest payload is used
    ms: 500, // wait 500ms of inactivity
  },
  mutation: () => api.updateName(newName),
});
```

During the debounce period, the window close is blocked to prevent data loss.

## Revalidation on Success

| Option                                           | Behavior                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| `revalidateOnSuccess: true`                      | Invalidates all affected items and queries                        |
| `revalidateOnSuccess: 'queries'`                 | (List Query only) Invalidates only queries, not individual items  |
| `revalidateOnSuccess: (query) => ...`            | (List Query only) Invalidates affected items and matching queries |
| `revalidateOnSuccess: { queries, items: false }` | (List Query only) Invalidates matching queries only               |
| `revalidateOnSuccess: false` (default)           | No automatic revalidation                                         |

### Error Handling

On error, TSDF **rolls back** optimistic updates to their pre-mutation state. Non-optimistic mutations leave state untouched on error.

## List Query Store Specific Options

```ts
await store.performMutation(payload, {
  // Revalidate only active queries, without invalidating individual items
  revalidateOnSuccess: {
    queries: (queryPayload) => queryPayload.status === 'active',
    items: false,
  },

  // Suppress the global onMutationError handler
  silentErrors: true,

  // Callbacks
  onSuccess: (response, payload) => {
    /* ... */
  },
  onError: (error) => {
    /* ... */
  },
});
```

## Manual Mutation Control

For cases where `performMutation` doesn't fit, you can manually control the mutation lock:

```ts
// Document Store
const endMutation = store.startMutation();
try {
  await doSomething();
} finally {
  endMutation();
}

// Collection Store — locks a specific item
const endMutation = store.startMutation('item-id');

// List Query Store — locks an item and all queries containing it
const endMutation = store.startItemMutation('item-id');
```

While a mutation lock is held, the scheduler defers any fetch requests for the locked items/queries.

## Window Close Blocking

The manager-level `blockWindowClose` option prevents the user from accidentally closing the browser during a mutation:

```ts
const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  errorNormalizer: normalizeError,
  blockWindowClose: () => {
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return {
      unblock: () => window.removeEventListener('beforeunload', handler),
    };
  },
});

const store = createDocumentStore({
  id: 'document-store',
  storeManager,
  // ...
});
```

Pass `null` to disable this behavior.

## Mutation Events

All stores emit events for mutation lifecycle tracking:

```ts
store.storeEvents.on('mutationStart', ({ mutationId }) => {
  console.log('Mutation started:', mutationId);
});

store.storeEvents.on('mutationEnd', ({ mutationId, status }) => {
  console.log('Mutation ended:', mutationId, status);
});
```

`status` is `'success' | 'error' | 'skipped'`. A mutation is `'skipped'` when its `optimisticUpdate` callback returns `false` or when a debounced mutation is superseded by a newer one with the same debounce key — these are not failures and should usually not trigger error handling.

Collection and List Query stores also include the affected `payload`/`items` in the event.
