# Test Review Checklist

Use this checklist to evaluate test quality quickly and consistently.

## Correctness

- Does each test verify externally visible behavior?
- Would a real regression fail this test?
- Are failure expectations specific (error type/message/state), not generic?

## Coverage

- Are success, failure, and edge cases covered?
- Are critical state transitions covered?
- Are invalid inputs and boundary conditions exercised?

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

## Severity Guide

- P0: Tests give false confidence on critical behavior or mask production bugs.
- P1: Important behavior is untested or tests are likely flaky.
- P2: Tests are brittle, unclear, or hard to maintain.
- P3: Minor readability or consistency issue with low risk.
