# Fetch Scheduling

TSDF uses a `RequestScheduler` to intelligently manage when and how fetches are executed. The scheduler handles priority levels, throttling, coalescing, batching, and mutation coordination.

## Priority Levels

Every fetch request has a priority that determines its behavior:

| Priority         | When used                                       | Behavior                                                                                                                                                            |
| ---------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lowPriority`    | Hook mount (default), window focus revalidation | Throttled — skipped if a fetch happened recently (within `lowPriorityThrottleMs`)                                                                                   |
| `mediumPriority` | Background refetches                            | Delayed by `mediumPriorityDelayMs`, then executed. Cancelled if another fetch starts. If the store has never been fetched, automatically promotes to `highPriority` |
| `realtimeUpdate` | Real-time data pushes                           | Uses `dynamicRealtimeThrottleMs` for adaptive throttling based on last fetch duration                                                                               |
| `highPriority`   | Explicit invalidation, `ensureIsLoaded`         | Executes immediately (after coalescing window). Never throttled                                                                                                     |

## Throttling

Low-priority fetches are throttled to avoid redundant requests:

```
lowPriorityThrottleMs: 5
```

If a hook mounts within the configured throttle window after the last fetch completed, the low-priority fetch is **skipped** because the data is still fresh enough.

## Coalescing

When multiple fetch requests arrive in a short window, they are coalesced into a single batch:

```
baseCoalescingWindowMs: 10
```

If three `useItem` hooks mount within the configured coalescing window, their fetches are grouped and executed as one request (when using batch fetching) or sequentially but without duplicate requests for the same item.

### Background Tabs

When synced browser tabs are open, TSDF can extend coalescing internally for background tabs based on focus ranking. Focused tabs keep `baseCoalescingWindowMs`; background tabs may wait longer so duplicate background work can be dropped when another tab is already fetching the same data.

See [Browser Tabs Sync](./browser-tabs-sync.md) for focus ranking and request deduplication behavior across tabs.

## Scheduler Phases

The scheduler is a state machine with three phases:

1. **Idle** - No pending fetches. New requests start the coalescing window.
2. **Coalescing** - Collecting requests within the coalescing window. New requests are added to the current batch.
3. **Fetching** - The batch is being executed. New requests are queued for the next cycle.

## Mutation Coordination

When a mutation is in progress for an item, the scheduler prevents conflicting fetches:

- New fetch requests for the mutating item are deferred to `scheduled` state
- If a fetch is already in progress when a mutation starts, the fetch is aborted
- After the mutation completes, deferred fetches execute automatically

This prevents race conditions where a fetch could overwrite optimistic updates.

## Medium Priority Behavior

Medium-priority fetches have special behavior:

1. The fetch is delayed by `mediumPriorityDelayMs`
2. If another fetch (of any priority) starts during the delay, the medium-priority fetch is cancelled
3. If the store has never been fetched (`wasLoaded === false`), the fetch is promoted to `highPriority` immediately

This is useful for background refetches that should yield to user-initiated actions.

## Configuration Reference

| Option                              | Required | Description                                                                                                                                                                                  |
| ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lowPriorityThrottleMs`             | No       | Manager default minimum interval between low-priority fetches, or a store-level override. Defaults to `5`                                                                                    |
| `baseCoalescingWindowMs`            | No       | Manager default time window to group multiple requests into a single batch, or a store-level override. Defaults to `10`                                                                      |
| `mediumPriorityDelayMs`             | No       | Delay before medium-priority fetches execute                                                                                                                                                 |
| `dynamicRealtimeThrottleMs`         | No       | Manager default or store override returning throttle duration for real-time updates. Built-in default: `100ms` focused, `1000ms` background. See [Real-Time Updates](./real-time-updates.md) |
| `maxBatchSize` / `maxItemBatchSize` | No       | Collection/ListQuery batch cap. List Query `maxItemBatchSize` defaults to `50`. Triggers immediate fetch when reached                                                                        |

## Typical Configuration

```ts
{
  // Skip refetch if one happened in the last 5ms
  lowPriorityThrottleMs: 5,

  // Group fetches within 10ms
  baseCoalescingWindowMs: 10,

  // Wait 300ms before executing medium-priority fetches
  mediumPriorityDelayMs: 300,
}
```
