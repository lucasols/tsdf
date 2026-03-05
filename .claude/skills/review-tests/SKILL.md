---
name: review-tests
description: Review automated tests for correctness, readability, reliability, maintainability, and coverage gaps. Use when asked to review tests, audit flaky tests, evaluate whether tests are meaningful, or identify missing scenarios in Vitest/TypeScript test suites.
---

# Review Tests

Perform a test-focused code review. Prioritize bugs, false confidence risks, readability/reviewability, flaky behavior, and missing coverage. Treat test readability as a first-class quality bar, not a style nit: tests should be state-of-the-art readable so a human can understand the scenario, timing, and regression being protected at a glance.

## Review Workflow

1. Define scope and intent.
2. Evaluate readability and reviewability.
3. Evaluate behavioral coverage.
4. Validate mock fidelity and test setup.
5. Validate assertion quality and failure signals.
6. Check determinism and flakiness risk.
7. Report findings ordered by severity.

## 1) Define Scope And Intent

- Identify the behavior each test file intends to protect.
- Map core production paths to explicit tests.
- Flag tests that assert implementation details without protecting behavior.

## 2) Evaluate Readability And Reviewability

- Treat readability as one of the top priorities in the review. If a test is difficult for a human to scan and understand quickly, that is a real defect in the test suite.
- Ask: can a reviewer understand the scenario, the actions, and the expected outcome at a glance without reverse-engineering the implementation?
- Flag tests whose narrative is buried across long setup blocks, scattered assertions, raw store poking, or transport/fetch-history details when a clearer structure or timeline snapshot would make the behavior obvious.
- Flag complex tests that do not present the scenario as a clear arrange/act/assert flow.
- Prefer tests that communicate the regression they guard against immediately through naming, comments, helpers, and snapshots.
- Do not treat readability findings as optional cleanup. If readability issues are present, report them even when you also found correctness or flakiness issues.

## 3) Evaluate Behavioral Coverage

- Check happy path, edge cases, error paths, and state transitions.
- Check that contract changes would fail tests in useful ways.
- Flag missing cases where production code can regress silently.
- Verify that test scenarios reflect realistic production usage — tests should simulate how the code is actually used in practice, not manufacture impossible or contrived sequences just to satisfy assertions.
- Flag tests that force artificial conditions (impossible state combinations, unrealistic timing, states that cannot occur in real usage) to make assertions pass. These create false confidence and may mask real bugs.
- Verify that test setup matches the scenario being tested. Initial state must reflect the real-world context of the behavior under test (for example, a test for "refetch on mount" should start with an already-loaded store, not an idle one — testing refetch from idle is a different scenario). Mismatched initial state makes the test verify the wrong behavior.

## 4) Validate Mock Fidelity And Test Setup

- Flag mocks that deviate from real behavior in ways that affect test validity (for example, a mock that resolves instantly when the real API is paginated, or a mock that never returns errors when the test is about error handling).
- Verify mocks preserve the behavioral contract of what they replace — response shape, timing characteristics, failure modes.
- Flag test setup that initializes state inconsistent with the scenario being tested. The initial conditions must be the ones that would naturally lead to the behavior under test in production.
- Use the project's shared test utilities (`createLoggerStore`, `flushAllTimers`, `advanceTime`, `range`, `pick`, test environment helpers from `tests/mocks/`) instead of rolling custom setup. Inconsistent setup across tests makes it harder to spot when initial conditions are wrong.

## 5) Validate Assertion Quality And Failure Signals

- Prefer assertions on user-visible or API-visible outcomes.
- Flag weak assertions (for example, only checking call count without verifying effect).
- Check negative assertions and error assertions for precision.
- Ensure snapshots are readable and scoped to meaningful behavior.
- **Flag tests with sequential actions over time that don't include `timelineString` snapshots.** Whenever a test performs a sequence of actions over time (fetches, refetches, invalidations, syncs), `timelineString` snapshots should be the primary assertion — they make the full sequence of events and their timing visible at a glance, replacing scattered point assertions.
- When a test involves multiple environments/tabs/stores, **all** timelines must be included so the reader can compare them side by side and trace connected actions across environments.
- Prefer using the existing tracking helpers (`trackUIChanges`, `trackItemUI`, logger/test env helpers) so timeline snapshots show the state transitions a reader actually cares about.
- Flag tests that use dense object assertions or raw fetch-history assertions where a focused `timelineString` snapshot would communicate the behavior more clearly.
- Flag tests that force the reader to reconstruct the scenario from many low-level assertions instead of showing the important behavior in one readable artifact.
- Flag assertions that only pass because the test setup created an unrealistic scenario. If the assertion requires bending production invariants, the test is wrong — not the code.

## 6) Check Determinism And Flakiness

- Flag reliance on real time, random values, network race timing, or global mutable state.
- Ensure async behavior is awaited and timers are controlled.
- Flag tests that depend on execution order or leaked state between tests.

## 7) Readability Standards

- Prefer focused tests with clear setup and intent.
- Default stance: unreadable tests are review findings, not polish opportunities.
- A strong test should let a human reviewer answer three questions in seconds: what is the setup, what changed, and what should happen next.
- Flag test names that are wrong, vague, or misleading relative to the actual assertions.
- Flag brittle fixtures, duplicated setup, and opaque data builders.
- Prefer human-readable snapshots over dense object comparisons.
- When a timeline snapshot can express the behavior clearly, prefer it as the primary readable artifact and keep additional assertions limited to key invariants or end-state checks.
- For cross-tab, cross-store, or time-based tests, missing or incomplete timelines are usually a significant readability defect, not a minor nit.
- Flag redundant tests — tests that assert the same behavior already covered by another test without adding meaningful coverage. Multiple tests should exist only when they exercise genuinely different paths, states, or edge cases. Copy-pasted tests with trivial variations, or tests that are strict subsets of a more comprehensive test, add maintenance cost without catching additional regressions.
- **Flag complex tests that lack comments.** Tests with multiple actions, non-obvious timing, or interleaved assertions must have comments explaining the intent behind each step and the expected behavior. Without comments, a reader must reverse-engineer the scenario from raw code, which makes it hard to tell whether the test is correct or what regression it guards against. Comments should explain **why**, not just label **what** (e.g., `// refetch while previous request is still in-flight — should deduplicate` rather than `// refetch`).
- Flag generic names for test scenarios, fixtures, and variables (`scenarioA`, `scenarioB`, `store1`, `store2`). Names should describe what makes each case distinct (e.g., `storeWithExpiredCache`, `fetchThatFailsOnce`) so a reader can understand the test without tracing through the setup.
- Prefer inline snapshots for object/array assertions instead of chaining multiple `expect(obj.a.b).toBe(...)` calls — a single snapshot communicates the full expected shape at a glance.
- Flag tests where related assertions are scattered across many individual `expect` calls when they could be grouped into one snapshot.
- Flag tests that mix transport assertions, fetch-history checks, and raw state checks without a clear primary assertion showing the user-visible story.
- Flag redundant or noise assertions that don't add confidence — re-checking already-asserted state, asserting obvious intermediate values, or verifying test setup rather than behavior. Every assertion should justify its existence by catching a distinct regression.

## 8) Report Findings

- Report findings first, ordered by severity.
- Include file and line references for each issue.
- Explain risk, expected impact, and the minimum fix.
- When readability problems exist, report them explicitly as findings. Do not hide them inside a summary or omit them because functional bugs were already found.
- For test reviews, assume the target quality bar is code a human can review at a glance. Judge unclear narrative, weak structure, and poor visual communication against that bar.
- Explicitly state when no findings were identified and list remaining testing gaps.

## Reference

- Use `references/test-review-checklist.md` as a compact scoring checklist during reviews.
