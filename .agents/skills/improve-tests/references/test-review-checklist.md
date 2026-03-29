# Test Review Checklist

Use this checklist to evaluate test quality quickly and consistently.

## Correctness

- Does each test verify externally visible behavior?
- Would a real regression fail this test?
- Are failure expectations specific (error type/message/state), not generic?
- Does the test scenario reflect a realistic production usage path, or does it force impossible conditions just to satisfy assertions?
- Is the behavior expressed through the highest practical public surface, rather than a lower-level implementation seam used only for convenience?
- Does the test use the real library flow plus boundary mocks, rather than a fake or simplified in-test version of existing behavior?

## Readability And Reviewability

- Can a human reviewer understand the setup, action, and expected outcome at a glance?
- Does the test tell a clear story top-to-bottom, or does it require reverse-engineering from low-level details?
- If the test is time-based, cross-tab, or multi-store, does it use `timelineString` snapshots as the primary readable artifact?
- When multiple environments are involved, are all relevant timelines shown side by side?
- Are comments present where timing or sequencing is non-obvious, and do they explain why each step matters?
- Do multi-phase `createLoggerStore` timelines use `.addMark('label')` to separate logical steps?
- Are related assertions grouped into readable snapshots instead of scattered across many `expect` calls?
- Is the test still readable if you ignore implementation details like raw store shape, fetch history, or transport internals?
- If the answer to any of these is no, treat it as a real review finding rather than optional polish.

## Coverage

- Are success, failure, and edge cases covered?
- Are critical state transitions covered?
- Are invalid inputs and boundary conditions exercised?
- Are the covered edge cases meaningful user-risk scenarios, or are some rare/low-risk cases adding maintenance cost without real confidence?

## Mock Fidelity And Test Setup

- Do mocks preserve the behavioral contract of what they replace (response shape, timing, failure modes)?
- Does the initial state match the scenario being tested (for example, an already-loaded store for refetch tests, an idle store for initial-load tests)?
- Are the project's shared test utilities used consistently (`createLoggerStore`, `flushAllTimers`, `advanceTime`, test environment helpers from `tests/mocks/`)?
- If fake timers are used, are the timings realistic and aligned with shared defaults or production-like behavior, rather than tiny convenience values?

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
- Does the test earn its complexity, or would it be better simplified, moved to a more realistic suite, or removed entirely?

## Severity Guide

- P0: Tests give false confidence on critical behavior or mask production bugs.
- P1: Important behavior is untested or tests are likely flaky.
- P2: Tests are brittle, unclear, hard to review quickly, or hard to maintain.
- P3: Minor readability or consistency issue with low risk.
