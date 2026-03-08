# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

TSDF (TypeScript Data Fetching) is a data fetching library built on top of `t-state`. It provides three main store types for managing server data in React applications:

- **DocumentStore**: For single documents/entities
- **CollectionStore**: For collections of items keyed by payload
- **ListQueryStore**: For paginated lists with item queries

## Development Commands

```bash
# Run tests
pnpm test

# Run tests for changed files only
pnpm test:changed

# Full lint (TypeScript check + ESLint + Prettier)
pnpm lint

# Type check only
pnpm tsc
```

### Running a Single Test

```bash
pnpm vitest run src/yourFile.test.ts
```

## Architecture

### Key Patterns

- Uses `t-state` for underlying state management with selectors and subscriptions
- `evtmitter` for event-based invalidation across store instances
- `immer` for immutable state updates via `produceState`

## Testing

Tests use Vitest with `happy-dom` environment. Test files follow the pattern `src/*.test.{ts,tsx}`.

### Test Environments (required)

Always use the pre-built test environments instead of manually creating stores with `createDocumentStore`, `createCollectionStore`, or `createListQueryStore`. The test envs provide a complete, realistic production-like scenario with server mocks, action tracking, timeline snapshots, and proper test wiring:

- **`createDocumentStoreTestEnv`** (`tests/mocks/documentStoreTestEnv.ts`) — for DocumentStore tests
- **`createCollectionStoreTestEnv`** (`tests/mocks/collectionStoreTestEnv.ts`) — for CollectionStore tests
- **`createListQueryStoreTestEnv`** (`tests/mocks/listQueryStoreTestEnv.ts`) — for ListQueryStore tests

Each test env returns an object with:

- `apiStore` — the store instance
- `store` — the underlying t-state store (for direct state access)
- `serverMock` / `serverTable` — server mock for controlling responses, errors, and data
- `scheduleFetch(fetchType, ...)` — schedule fetches with automatic action logging
- `performClientUpdateAction(...)` / `performClientItemUpdateAction(...)` — perform mutations with built-in optimistic update and revalidation support
- `trackUIChanges(selector)` / `trackItemUI(itemId, selector)` — track UI state changes for timeline snapshots
- `timelineString` — human-readable timeline of all actions (fetches, mutations, UI changes, etc.)
- `actions` — raw action history array
- `addTimelineComments(...)` — annotate the timeline with custom comments

Test scenarios can be configured via the `testScenario` option to start tests in different states:

- `'idle'` — fresh app, no data (default)
- `'loaded'` — data already fetched successfully
- `{ loadedWithStaleData: ... }` — loaded but server has newer data

Do not manually wire up fetch functions, error normalizers, or event handlers — the test envs handle all of this. See existing tests in `tests/` for usage examples.

### General testing guidelines

- Prefer using toMatchInlineSnapshot instead of toBe or toEqual for object assertions
- Tests use a YAML snapshot serializer instead of the default vitest snapshot serializer. Using `compactSnapshot` from `@ls-stack/utils/testUtils` to serialize the snapshot. Boolean values are serialized as `❌` or `✅` instead of `true` or `false`.
- Tests should be optimized for human readability
- Prefer using vitest fake timers
- When value changes over time are relevant, use `createLoggerStore` or `timelineString` to create human-readable timeline snapshots instead of multiple `expect` statements at different points in time.
  - `createLoggerStore`: log values with `.add(value)`, assert with `.changesSnapshot`, and use `.addMark('label')` to annotate the timeline with markers separating phases of the test.
  - `timelineString`: provided by test envs, captures the full timeline of fetches, mutations, and UI changes automatically.
- When asserting server mock requests, prefer `serverTable.getRequestHistory('item' | 'list' | 'all')` over reading `serverTable.fetchHistory` directly. Use raw `fetchHistory` only when `getRequestHistory(...)` cannot express the assertion you need.
- Use realistic times to match real usage, use as reference the default fetch durations used in the server mocks
- Use utility functions from `tests/utils/genericTestUtils.ts` when possible:
  - `flushAllTimers()`: wraps `vi.runAllTimersAsync()` in `act()` — use instead of calling `vi.runAllTimersAsync()` directly
  - `advanceTime(ms)`: wraps `vi.advanceTimersByTimeAsync(ms)` in `act()` — use instead of calling `vi.advanceTimersByTimeAsync()` directly
  - `range(start, end)`: creates an array of numbers from start to end (inclusive)
  - `pick(obj, keys)`: picks specific keys from an object

## General Guidelines

- Prefer simple, direct solutions — don't over-engineer or add unnecessary layers of abstraction
- Only introduce abstractions when they make the code simpler, more maintainable, or more readable — duplicating a few lines is preferable to a forced abstraction
- Avoid unnecessary boilerplate

## Feature implementation

When adding a new feature, or adjust a existing one:

- add comprehensive tests covering the new behavior, relevant edge cases and potential regressions
  - follow existing test patterns — see `tests/` for examples and `tests/mocks/` for test
    utilities
- add jsdoc comments to the public API available to library users
  - when adding jsdoc to function arguments prefer adding them to the types/interfaces instead of the implementation, to ensure they are visible in IDEs when users hover the relevant types
- if adding new public exports, update the relevant barrel file (`src/main.ts`)

## Bug fix instructions

When fixing a bug:

1. add a test that asserts the correct behavior and reproduces the issue, if possible. Only create a test if the test simulates a realistic scenario that could happen in real usage.
2. confirm that the test fails before applying the fix, to ensure the test is valid
3. check the root cause of the issue and apply the fix, don't apply a superficial fix that only makes the test pass without addressing the underlying problem.
4. apply the fix and confirm that the test passes after the fix is applied
