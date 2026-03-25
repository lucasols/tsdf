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

## Intent over literalism

- Do not follow user or reviewer instructions mechanically when they conflict with the likely product intent, existing architecture, or the simplest correct solution.
- First infer the real goal behind the request, then implement the smallest change that solves that goal well.
- Prefer improving or simplifying the requested approach when that produces a clearer, safer, or more local solution.
- Avoid "instruction-shaped overengineering": do not introduce new abstractions, configuration shapes, or refactors unless they are necessary for the actual problem being solved.
- If a request appears technically suboptimal but still ambiguous, pause and sanity-check it before implementing. If the intent is clear, choose the better solution and explain the assumption briefly.
- If the request is too vague, contradictory, or underspecified to infer intent safely, ask a focused clarifying question before implementing.
- Only ask for clarification when the ambiguity materially affects the solution, scope, or risk. Otherwise, make the most reasonable assumption and keep the change moving.

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
- Add comments to explain the purpose of different phases of the test, especially when using `expect` statements, to make it easier for future readers to understand the intent of the test
- After updating snapshots automatically via `vitest --update-snapshots` or `vitest -u`, check the diff to ensure that the updates are expected and not regressions.

### Test isolation from production code

- **Never modify production code to fix or work around test issues.** If a test is failing, the fix must be at the test level — adjust mocks, test setup, assertions, or test utilities.
- Tests should use mocks and test utilities to simulate the conditions they need. Do not add hooks, flags, or conditional logic in production code solely to make tests easier to write.
- The only acceptable exception is tree-shakable compile-time guards like `import.meta.TEST` that are fully eliminated from production builds and have zero runtime impact on prod.
- If production code genuinely has a bug, fix the bug properly — but the test that exposed it should still not require production code to be shaped around test concerns.

## General Guidelines

- Prefer simple, direct solutions — don't over-engineer or add unnecessary layers of abstraction
- Only introduce abstractions when they make the code simpler, more maintainable, or more readable — duplicating a few lines is preferable to a forced abstraction
- Avoid unnecessary boilerplate

## Alpha-stage API policy

- This library is still in a major-version alpha stage and is not in production yet; prioritize a clean, coherent API over backward compatibility
- Do not add fallback behavior, legacy code paths, compatibility shims, optional support for old shapes, or migration-oriented branching unless the user explicitly asks for it
- When changing an API or stored data shape, prefer replacing the old behavior outright instead of preserving both the old and new forms

### Major rewrite mode

This codebase is undergoing a major rewrite. Assume the current implementation is wrong until proven otherwise — read the tests to understand intended behavior, not the code.

- **Tests are the source of truth.** Write the simplest code that satisfies them. If a test encodes a bad design, flag it instead of working around it.
- **Be suspicious of existing code.** Actively look for unnecessary complexity, dead paths, poor naming, and over-engineering. Call out issues even outside your immediate task scope. Consider that current code is suboptimal until proven otherwise.
- **Rewrite freely.** Large diffs are expected. Don't preserve patterns for consistency with bad code.
- **Public API changes are allowed.** Don't hesitate to rename exports, change hook signatures, or restructure config objects if it results in a better and simpler API.

## Feature implementation

When adding a new feature, or adjust a existing one:

- add comprehensive tests covering the new behavior, relevant edge cases and potential regressions
  - follow existing test patterns — see `tests/` for examples and `tests/mocks/` for test
    utilities
- add jsdoc comments to the public API available to library users
  - when adding jsdoc to function arguments prefer adding them to the types/interfaces instead of the implementation, to ensure they are visible in IDEs when users hover the relevant types
- if adding new public exports, update the relevant barrel file (`src/main.ts`)
- if the feature requires changes to the documentation, update the relevant docs files in `docs/` and public api jsdoc comments in `src/`
- run `pnpm test` and `pnpm lint` — fix any issues until all pass with no errors
- after implementing the changes, check if there are no performance regressions compared to previous implementation that could be avoided with a better implementation

## Optimization instructions

When applying an optimization:

1. confirm what the optimization is improving and which concrete paths are affected, so the change is grounded in real behavior rather than guesswork.
2. be proactive about expanding the optimization to the full affected surface area when the same performance pattern is clearly present elsewhere. In this repo, do not stop at a single store or code path if the same optimization obviously also applies to `DocumentStore`, `CollectionStore`, `ListQueryStore`, sync/async variants, or closely related persistence flows.
3. after optimizing one concrete case, actively inspect sibling implementations for the same opportunity instead of waiting for the user to ask.
4. if applying the optimization more broadly has non-obvious tradeoffs, risks changing intended behavior, or could make one path less clear or maintainable, pause and surface those tradeoffs explicitly before proceeding.
5. verify that the optimization does not introduce behavioral regressions, and check whether the broader version of the optimization is still simple, direct, and worth keeping.

## Bug fix instructions

When fixing a bug:

1. add a test that asserts the correct behavior and reproduces the issue, if possible. Only create a test if the test simulates a realistic scenario that could happen in real usage.
2. confirm that the test fails before applying the fix, to ensure the test is valid
3. check the root cause of the issue and apply the fix, don't apply a superficial fix that only makes the test pass without addressing the underlying problem.
4. be proactive about expanding the fix to the full affected surface area when the same root cause or pattern is clearly present elsewhere. In this repo, do not stop at a single store or code path if the same bug obviously also affects `DocumentStore`, `CollectionStore`, `ListQueryStore`, sync/async variants, or closely related persistence flows.
5. after fixing one concrete case, actively check the sibling implementations for the same issue instead of waiting for the user to ask. If the broader fix has non-obvious tradeoffs or a meaningful risk of changing intended behavior, pause and surface those tradeoffs explicitly before proceeding.
6. apply the fix and confirm that the test passes after the fix is applied
7. run `pnpm test` and `pnpm lint` — fix any issues until all pass with no errors
8. after fixing the bug, check there are no performance regressions compared to previous implementation that could be avoided with a better fix

## Self-review of test changes (MANDATORY)

**CRITICAL: This section is non-optional. You MUST follow these steps after ANY task that introduces or modifies tests, before considering the task complete.**

After completing any task that adds, modifies, or removes test code:

1. **Review every test diff you introduced.** Re-read the full diff of all test files you changed. Do not skip this step — it catches issues that are invisible during writing but obvious on review.
2. **Check for behavior regressions.** Compare your test changes against the previous test expectations. If you weakened an assertion, removed a test case, loosened a snapshot, or changed expected values, confirm the change is intentional and correct — not a side effect of making tests pass. If you cannot justify the change, revert it and fix the underlying issue instead.
3. **Check for performance regressions.** If your changes altered how data is fetched, stored, serialized, or compared, verify the new approach is not doing unnecessary work compared to the previous implementation. Look for: redundant iterations, unnecessary re-renders, extra serialization/deserialization cycles, duplicate storage reads/writes, or O(n²) patterns where O(n) is possible.
4. **Check for test quality regressions.** Ensure your tests are not:
   - Testing implementation details instead of behavior
   - Using overly broad assertions that would pass even with broken code
   - Missing edge cases that the previous tests covered
   - Adding unnecessary complexity or boilerplate
5. **Fix or report.** If you find a regression that has a better implementation, fix it immediately. If the regression is inherent to the approach and cannot be avoided without a fundamentally different design, report it to the user explicitly with a clear explanation of the tradeoff before proceeding.

## Useful patterns

- For unsafe data parsing, use `runcheck` lib

## Bad patterns to avoid

- Avoid as much as possible using `__LEGIT_CAST__`, it should be the ultimate last resort when properly typing the code is not possible.
  - As alternative consider using `runcheck` schemas when dealing with unsafe data parsing.
