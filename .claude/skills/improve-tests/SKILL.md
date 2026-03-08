---
name: improve-tests
description: Improve automated tests by default: strengthen coverage, readability, determinism, and failure signals in Vitest/TypeScript suites. Only switch to review-only mode when the user explicitly asks for a review or audit.
---

# Improve Tests

Default mode is to improve tests, not just critique them. Read the relevant tests, identify the highest-value changes, implement them, and verify the result. Only stay in review mode when the user explicitly asks to review, audit, or evaluate tests without changing them.

## Modes

- `Improve` (default): make concrete test changes. Add or rewrite tests, improve structure/readability, replace weak assertions, reduce flakiness, and run the relevant test commands.
- `Review` (only when explicitly requested): inspect tests and report prioritized findings without changing files unless the user then asks for fixes.

## Improve Workflow

1. Define scope and intent.
2. Identify the most valuable test improvements.
3. Implement the test changes.
4. Validate realism, readability, and determinism.
5. Run relevant tests and lint/type-check when appropriate.
6. Summarize what changed, what improved, and any remaining gaps.

## 1) Define Scope And Intent

- Identify the behavior each test file is supposed to protect.
- Map core production paths to explicit tests.
- Distinguish whether the user wants:
  - better tests by default, or
  - a review-only pass with findings and no edits.
- When the request is ambiguous, default to improving the tests.

## 2) Identify The Most Valuable Improvements

- Prioritize changes that improve regression protection, readability, and trustworthiness.
- Focus first on:
  - missing realistic scenarios,
  - tests that give false confidence,
  - flaky/nondeterministic behavior,
  - assertions that are too weak or too low-level,
  - tests whose story is hard to follow.
- Prefer a small number of high-signal improvements over many low-value edits.

## 3) Implement The Test Changes

- Add or rewrite tests to cover realistic production behavior.
- Prefer the project's shared test environments and utilities instead of hand-rolled setup.
- Strengthen assertions so failures explain the regression clearly.
- Prefer readable snapshots, timelines, and helpers over dense low-level expectations.
- Improve naming, comments, and structure so the scenario is obvious at a glance.

## 4) Validate Readability And Reviewability

- Treat readability as one of the top priorities in the review. If a test is difficult for a human to scan and understand quickly, that is a real defect in the test suite.
- Ask: can a reviewer understand the scenario, the actions, and the expected outcome at a glance without reverse-engineering the implementation?
- Default rule: include short intent comments throughout the flow, not just at the top. A reader should be able to scan the comments and understand why each phase exists before parsing the mechanics.
- Flag tests whose narrative is buried across long setup blocks, scattered assertions, raw store poking, or transport/`fetchHistory` details when a clearer structure, timeline snapshot, or `getRequestHistory(...)` assertion would make the behavior obvious.
- Flag complex tests that do not present the scenario as a clear arrange/act/assert flow.
- Prefer tests that communicate the regression they guard against immediately through naming, comments, helpers, and snapshots.
- Do not treat readability issues as optional cleanup. In improve mode, fix them. In review mode, report them.

## 5) Validate Behavioral Coverage

- Check happy path, edge cases, error paths, and state transitions.
- Check that contract changes would fail tests in useful ways.
- Flag missing cases where production code can regress silently.
- Verify that test scenarios reflect realistic production usage — tests should simulate how the code is actually used in practice, not manufacture impossible or contrived sequences just to satisfy assertions.
- Flag tests that force artificial conditions (impossible state combinations, unrealistic timing, states that cannot occur in real usage) to make assertions pass. These create false confidence and may mask real bugs.
- Verify that test setup matches the scenario being tested. Initial state must reflect the real-world context of the behavior under test (for example, a test for "refetch on mount" should start with an already-loaded store, not an idle one — testing refetch from idle is a different scenario). Mismatched initial state makes the test verify the wrong behavior.

## 6) Validate Mock Fidelity And Test Setup

- Flag mocks that deviate from real behavior in ways that affect test validity (for example, a mock that resolves instantly when the real API is paginated, or a mock that never returns errors when the test is about error handling).
- Verify mocks preserve the behavioral contract of what they replace — response shape, timing characteristics, failure modes.
- Flag test setup that initializes state inconsistent with the scenario being tested. The initial conditions must be the ones that would naturally lead to the behavior under test in production.
- Use the project's shared test utilities (`createLoggerStore`, `flushAllTimers`, `advanceTime`, `range`, `pick`, test environment helpers from `tests/mocks/`) instead of rolling custom setup. Inconsistent setup across tests makes it harder to spot when initial conditions are wrong.
- Treat raw `fetchHistory` assertions as a default review finding when `serverTable.getRequestHistory('item' | 'list' | 'all')` can express the same behavior. Prefer `getRequestHistory(...)` because it snapshots the request contract instead of low-level transport internals; fall back to raw `fetchHistory` only when the higher-level helper cannot express the assertion.

## 7) Validate Assertion Quality And Failure Signals

- Prefer assertions on user-visible or API-visible outcomes.
- Flag weak assertions (for example, only checking call count without verifying effect).
- Check negative assertions and error assertions for precision.
- Ensure snapshots are readable and scoped to meaningful behavior.
- **Flag tests with sequential actions over time that don't include `timelineString` snapshots.** Whenever a test performs a sequence of actions over time (fetches, refetches, invalidations, syncs), `timelineString` snapshots should be the primary assertion — they make the full sequence of events and their timing visible at a glance, replacing scattered point assertions.
- When a test involves multiple environments/tabs/stores, **all** timelines must be included so the reader can compare them side by side and trace connected actions across environments.
- Prefer using the existing tracking helpers (`trackUIChanges`, `trackItemUI`, logger/test env helpers) so timeline snapshots show the state transitions a reader actually cares about.
- When `createLoggerStore` snapshots include arrays that matter to the behavior under test (for example item names, ids, or ordered query membership), prefer `createLoggerStore({ arrays: 'all' })` so the snapshot shows the full array instead of a shortened summary.
- Flag `createLoggerStore` timelines with multiple logical phases that don't use `.addMark('label')` to separate them — without markers, the reader must infer where each phase starts and ends.
- Flag tests that use dense object assertions or raw `fetchHistory` assertions where a focused `timelineString`, `.changesSnapshot`, or `serverTable.getRequestHistory(...)` assertion would communicate the behavior more clearly.
- Flag tests that inspect `fetchHistory` directly when `getRequestHistory(...)` would cover the scenario. Ask for the assertion to be replaced with `serverTable.getRequestHistory('item' | 'list' | 'all')` unless the test genuinely needs transport-only details that the shared helper does not expose.
- Flag tests that force the reader to reconstruct the scenario from many low-level assertions instead of showing the important behavior in one readable artifact.
- Flag assertions that only pass because the test setup created an unrealistic scenario. If the assertion requires bending production invariants, the test is wrong — not the code.

## 8) Check Determinism And Flakiness

- Flag reliance on real time, random values, network race timing, or global mutable state.
- Ensure async behavior is awaited and timers are controlled.
- Flag tests that depend on execution order or leaked state between tests.

## 9) Readability Standards

- Prefer focused tests with clear setup and intent.
- Default stance: unreadable tests are review findings, not polish opportunities.
- A strong test should let a human reviewer answer three questions in seconds: what is the setup, what changed, and what should happen next.
- Flag test names that are wrong, vague, or misleading relative to the actual assertions.
- Flag brittle fixtures, duplicated setup, and opaque data builders.
- Prefer human-readable snapshots over dense object comparisons.
- When a timeline snapshot can express the behavior clearly, prefer it as the primary readable artifact and keep additional assertions limited to key invariants or end-state checks.
- Flag logger snapshots that hide relevant array contents behind abbreviated formatting when `createLoggerStore({ arrays: 'all' })` would make the protected behavior obvious at a glance.
- For cross-tab, cross-store, or time-based tests, missing or incomplete timelines are usually a significant readability defect, not a minor nit.
- Flag redundant tests — tests that assert the same behavior already covered by another test without adding meaningful coverage. Multiple tests should exist only when they exercise genuinely different paths, states, or edge cases. Copy-pasted tests with trivial variations, or tests that are strict subsets of a more comprehensive test, add maintenance cost without catching additional regressions.
- **Flag tests that lack intent comments.** Default expectation: every non-trivial test should include short comments that explain the purpose of each important setup/action/assert phase, especially in time-based, persistence, hydration, retry, sync, cross-tab, or otherwise stateful scenarios. Without comments, a reader must reverse-engineer the scenario from raw code, which makes it hard to tell whether the test is correct or what regression it guards against. Comments should explain **why**, not just label **what** (e.g., `// refetch while previous request is still in-flight — should deduplicate` rather than `// refetch`).
- Flag generic names for test scenarios, fixtures, and variables (`scenarioA`, `scenarioB`, `store1`, `store2`). Names should describe what makes each case distinct (e.g., `storeWithExpiredCache`, `fetchThatFailsOnce`) so a reader can understand the test without tracing through the setup.
- Prefer inline snapshots for object/array assertions instead of chaining multiple `expect(obj.a.b).toBe(...)` calls — a single snapshot communicates the full expected shape at a glance.
- Flag tests where related assertions are scattered across many individual `expect` calls when they could be grouped into one snapshot.
- Flag tests that mix transport assertions, `fetchHistory` checks, and raw state checks without a clear primary assertion showing the user-visible story. In most cases the `fetchHistory` part should be replaced with `serverTable.getRequestHistory(...)`.
- Flag redundant or noise assertions that don't add confidence — re-checking already-asserted state, asserting obvious intermediate values, or verifying test setup rather than behavior. Every assertion should justify its existence by catching a distinct regression.

## 10) Deliver The Result

- In `Improve` mode:
  - summarize the test changes you made,
  - report which commands you ran,
  - call out any remaining gaps or risks.
- In `Review` mode:
  - report findings first, ordered by severity,
  - include file and line references,
  - explain risk, expected impact, and the minimum fix,
  - explicitly state when no findings were identified and list remaining testing gaps.

## Reference

- Use `references/test-review-checklist.md` as a compact checklist during review-only requests.
