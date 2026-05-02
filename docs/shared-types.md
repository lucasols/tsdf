# Shared Types & Utilities

Common types and utilities used across all TSDF store types.

## StoreError

The normalized error type used across all stores. Your `errorNormalizer` function converts raw exceptions into this shape:

```ts
type StoreError = {
  code: number;
  id: string;
  message: string;
  path?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
};
```

## StoreFetchError

An `Error` subclass returned by `awaitFetch` methods. Contains the same fields as `StoreError` plus a `type` indicating why the fetch failed:

- `'fetch'` — the fetch function threw an error
- `'timeout'` — the fetch exceeded the specified `timeoutMs`
- `'aborted'` — the fetch was aborted (e.g., due to a mutation starting)

## StoreMutationError

An `Error` subclass returned by `performMutation` when the mutation fails.
It contains the normalized `StoreError` fields plus:

- `kind: 'error'`
- `cause` — the original thrown value, preserved via `Error.cause`

## StoreMutationErrorOptions

Options passed to store-level and manager-level `onMutationError` handlers:

```ts
type StoreMutationErrorOptions = { silentErrors?: boolean };
```

When `silentErrors` is true, the handler is still called. Use the flag to keep
centralized logging or recovery behavior while suppressing user-facing
notifications such as error toasts.

## MutationSkipped

A sentinel returned by `performMutation` when the mutation is intentionally not
run, for example because:

- `optimisticUpdate` returned `false`
- a debounced mutation call was superseded by a newer call

Shape:

```ts
type MutationSkipped = { kind: 'skipped' };
```

## Fetch Priorities

Priority levels for [fetch scheduling](./fetch-scheduling.md). Higher priority fetches override lower ones:

- `lowPriority` (0) — Default hook mount fetches
- `mediumPriority` (1) — Background refetches
- `realtimeUpdate` (2) — Push-based updates
- `highPriority` (3) — Explicit invalidation, user actions

## ValidPayload

Payloads that identify items or queries must be one of:

- `number` — e.g., `42`
- `string` — e.g., `'user-123'`
- `Record<string, unknown>` — e.g., `{ projectId: 'proj-1', status: 'active' }`

Payloads are converted to composite keys internally for state storage. Object payloads are serialized deterministically (key order doesn't matter).

## PayloadDebounce

Configuration for debouncing automatic fetches triggered by rapid payload
changes in payload-based hooks.

Supported by:

- `useItem`
- `useListQuery`
- `useMultipleItems`
- `useMultipleListQueries`

Shape:

```ts
type PayloadDebounce = { ms: number; maxWait?: number; leading?: boolean };
```

Fields:

- `ms` — debounce window in milliseconds
- `maxWait` — optional upper bound for how long a burst may stay deferred
- `leading` — allows the first payload in a burst to fetch immediately

Important behavior:

- The hook still reads from state using the latest payload immediately
- Only the automatic fetch side is delayed
- If cached data already exists for the latest payload, the hook can still
  return it immediately while the fetch is deferred
- `useItem` and `useListQuery` do not support combining `debouncePayload` with
  `ensureIsLoaded`

Example:

```tsx
const result = store.useListQuery(
  { search, status: 'active' },
  { debouncePayload: { ms: 300, leading: true, maxWait: 1200 } },
);
```

See [React Hooks](./hooks.md#debouncepayload) for usage patterns.

## IsOffScreenContext

A React context that disables all TSDF hooks in a subtree when set to `true`. Useful for tabs, modals, or off-screen content that shouldn't trigger fetches.

```tsx
import { IsOffScreenContext } from 'tsdf';

function TabPanel({ isActive, children }) {
  return (
    <IsOffScreenContext.Provider value={!isActive}>
      {children}
    </IsOffScreenContext.Provider>
  );
}
```

When `IsOffScreenContext` is `true`:

- Hooks don't trigger fetches
- Hooks don't respond to invalidation events
- Individual hooks can override via their `isOffScreen` prop

## fetchTypePriority

Numeric mapping of fetch priorities for comparison:

```ts
import { fetchTypePriority } from 'tsdf';

fetchTypePriority.lowPriority; // 0
fetchTypePriority.mediumPriority; // 1
fetchTypePriority.realtimeUpdate; // 2
fetchTypePriority.highPriority; // 3
```

## BlockWindowCloseHandler

A function that blocks the browser window from closing during mutations. Returns an object with an `unblock` method:

```ts
const blockWindowClose = () => {
  const handler = (e: BeforeUnloadEvent) => {
    e.preventDefault();
  };
  window.addEventListener('beforeunload', handler);
  return { unblock: () => window.removeEventListener('beforeunload', handler) };
};
```

Pass `null` to `createStoreManager({ blockWindowClose })` to disable this behavior.

## MutationDebounce

Configuration for debouncing [mutations](./mutations.md):

- `context` — Debounce key. Mutations with the same context are debounced together
- `payload` — The latest payload replaces previous ones during the debounce window
- `ms` — Milliseconds of inactivity before the mutation executes
