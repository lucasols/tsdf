---
name: review-tests
description: Review automated tests for correctness, reliability, maintainability, and coverage gaps. Use when asked to review tests in a PR, audit flaky tests, evaluate whether tests are meaningful, or identify missing scenarios in Vitest/TypeScript test suites.
---

# Review Tests

Perform a test-focused code review. Prioritize bugs, false confidence risks, flaky behavior, and missing coverage over style nits.

## Review Workflow

1. Define scope and intent.
2. Evaluate behavioral coverage.
3. Validate assertion quality and failure signals.
4. Check determinism and flakiness risk.
5. Evaluate readability and long-term maintenance.
6. Report findings ordered by severity.

## 1) Define Scope And Intent

- Identify the behavior each test file intends to protect.
- Map core production paths to explicit tests.
- Flag tests that assert implementation details without protecting behavior.

## 2) Evaluate Behavioral Coverage

- Check happy path, edge cases, error paths, and state transitions.
- Check that contract changes would fail tests in useful ways.
- Flag missing cases where production code can regress silently.

## 3) Validate Assertion Quality

- Prefer assertions on user-visible or API-visible outcomes.
- Flag weak assertions (for example, only checking call count without verifying effect).
- Check negative assertions and error assertions for precision.
- Ensure snapshots are readable and scoped to meaningful behavior.

## 4) Check Determinism And Flakiness

- Flag reliance on real time, random values, network race timing, or global mutable state.
- Ensure async behavior is awaited and timers are controlled.
- Flag tests that depend on execution order or leaked state between tests.

## 5) Evaluate Maintainability

- Prefer focused tests with clear setup and intent.
- Flag test names that are wrong, vague, or misleading relative to the actual assertions.
- Flag brittle fixtures, duplicated setup, and opaque data builders.
- Prefer human-readable snapshots over dense object comparisons.

## 6) Report Findings

- Report findings first, ordered by severity.
- Include file and line references for each issue.
- Explain risk, expected impact, and the minimum fix.
- Explicitly state when no findings were identified and list remaining testing gaps.

## Reference

- Use `references/test-review-checklist.md` as a compact scoring checklist during reviews.
