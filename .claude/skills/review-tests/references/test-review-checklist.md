# Test Review Checklist

Use this checklist to evaluate test quality quickly and consistently.

## Correctness

- Does each test verify externally visible behavior?
- Would a real regression fail this test?
- Are failure expectations specific (error type/message/state), not generic?
- Does the test scenario reflect a realistic production usage path, or does it force impossible conditions just to satisfy assertions?

## Coverage

- Are success, failure, and edge cases covered?
- Are critical state transitions covered?
- Are invalid inputs and boundary conditions exercised?

## Mock Fidelity And Test Setup

- Do mocks preserve the behavioral contract of what they replace (response shape, timing, failure modes)?
- Does the initial state match the scenario being tested (for example, an already-loaded store for refetch tests, an idle store for initial-load tests)?
- Are the project's shared test utilities used consistently (`createLoggerStore`, `flushAllTimers`, `advanceTime`, test environment helpers from `tests/mocks/`)?

## Reliability

- Is async behavior fully awaited?
- Are timers controlled with fake timers when timing matters?
- Does the test avoid nondeterminism (wall clock, randomness, race timing)?
- Does setup/teardown prevent shared-state leakage?

## Maintainability

- Is setup minimal and intent obvious?
- Does each test name accurately describe the behavior it verifies?
- Is duplication low and fixture data readable?
- Are snapshots small, intentional, and understandable?
- Does each test cover a genuinely distinct behavior, or is it redundant with another test?

## Severity Guide

- P0: Tests give false confidence on critical behavior or mask production bugs.
- P1: Important behavior is untested or tests are likely flaky.
- P2: Tests are brittle, unclear, or hard to maintain.
- P3: Minor readability or consistency issue with low risk.
