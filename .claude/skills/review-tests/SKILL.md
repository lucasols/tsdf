---
name: review-tests
description: Review automated tests for correctness, reliability, maintainability, and coverage gaps. Use when asked to review tests in a PR, audit flaky tests, evaluate whether tests are meaningful, or identify missing scenarios in Vitest/TypeScript test suites.
---

# Review Tests

Perform a test-focused code review. Prioritize bugs, false confidence risks, flaky behavior, and missing coverage over style nits.

## Review Workflow

1. Define scope and intent.
2. Evaluate behavioral coverage.
3. Validate mock fidelity and test setup.
4. Validate assertion quality and failure signals.
5. Check determinism and flakiness risk.
6. Evaluate readability and long-term maintenance.
7. Report findings ordered by severity.

## 1) Define Scope And Intent

- Identify the behavior each test file intends to protect.
- Map core production paths to explicit tests.
- Flag tests that assert implementation details without protecting behavior.

## 2) Evaluate Behavioral Coverage

- Check happy path, edge cases, error paths, and state transitions.
- Check that contract changes would fail tests in useful ways.
- Flag missing cases where production code can regress silently.
- Verify that test scenarios reflect realistic production usage — tests should simulate how the code is actually used in practice, not manufacture impossible or contrived sequences just to satisfy assertions.
- Flag tests that force artificial conditions (impossible state combinations, unrealistic timing, states that cannot occur in real usage) to make assertions pass. These create false confidence and may mask real bugs.
- Verify that test setup matches the scenario being tested. Initial state must reflect the real-world context of the behavior under test (for example, a test for "refetch on mount" should start with an already-loaded store, not an idle one — testing refetch from idle is a different scenario). Mismatched initial state makes the test verify the wrong behavior.

## 3) Validate Mock Fidelity And Test Setup

- Flag mocks that deviate from real behavior in ways that affect test validity (for example, a mock that resolves instantly when the real API is paginated, or a mock that never returns errors when the test is about error handling).
- Verify mocks preserve the behavioral contract of what they replace — response shape, timing characteristics, failure modes.
- Flag test setup that initializes state inconsistent with the scenario being tested. The initial conditions must be the ones that would naturally lead to the behavior under test in production.
- Use the project's shared test utilities (`createLoggerStore`, `flushAllTimers`, `advanceTime`, `range`, `pick`, test environment helpers from `tests/mocks/`) instead of rolling custom setup. Inconsistent setup across tests makes it harder to spot when initial conditions are wrong.

## 4) Validate Assertion Quality And Failure Signals

- Prefer assertions on user-visible or API-visible outcomes.
- Flag weak assertions (for example, only checking call count without verifying effect).
- Check negative assertions and error assertions for precision.
- Ensure snapshots are readable and scoped to meaningful behavior.
- When sequencing, throttling, coalescing, focus changes, websocket delivery, or other time-ordered behavior is central to the test, prefer timeline snapshots over scattered point assertions when the test env exposes `timelineString`.
- Prefer using the existing tracking helpers (`trackUIChanges`, `trackItemUI`, logger/test env helpers) so timeline snapshots show the state transitions a reader actually cares about.
- Flag tests that use dense object assertions or raw fetch-history assertions where a focused `timelineString` snapshot would communicate the behavior more clearly.
- Flag assertions that only pass because the test setup created an unrealistic scenario. If the assertion requires bending production invariants, the test is wrong — not the code.

## 5) Check Determinism And Flakiness

- Flag reliance on real time, random values, network race timing, or global mutable state.
- Ensure async behavior is awaited and timers are controlled.
- Flag tests that depend on execution order or leaked state between tests.

## 6) Evaluate Maintainability

- Prefer focused tests with clear setup and intent.
- Flag test names that are wrong, vague, or misleading relative to the actual assertions.
- Flag brittle fixtures, duplicated setup, and opaque data builders.
- Prefer human-readable snapshots over dense object comparisons.
- When a timeline snapshot can express the behavior clearly, prefer it as the primary readable artifact and keep additional assertions limited to key invariants or end-state checks.
- Flag redundant tests — tests that assert the same behavior already covered by another test without adding meaningful coverage. Multiple tests should exist only when they exercise genuinely different paths, states, or edge cases. Copy-pasted tests with trivial variations, or tests that are strict subsets of a more comprehensive test, add maintenance cost without catching additional regressions.

## 7) Report Findings

- Report findings first, ordered by severity.
- Include file and line references for each issue.
- Explain risk, expected impact, and the minimum fix.
- Explicitly state when no findings were identified and list remaining testing gaps.

## Reference

- Use `references/test-review-checklist.md` as a compact scoring checklist during reviews.
