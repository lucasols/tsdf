---
name: fix-lint
description: >
  Identify and fix lint issues in the project: TypeScript type errors, oxlint/fast-lint errors, and formatting issues.
  Triggers: "fix lint errors", "fix eslint errors", "fix type errors", "run lint", "check types",
  "fix lint", "lint is failing", "CI lint failure", or after making code changes that may introduce errors.
---

# Fix Lint

## Commands

| Command          | What it runs                                    | When to use                                         |
| ---------------- | ----------------------------------------------- | --------------------------------------------------- |
| `pnpm lint`      | `pnpm oxlint`, `pnpm fast-lint`, extra projects | Full check (type errors + lint rules)               |
| `pnpm oxlint`    | `oxlint --type-check src/ tests/ --fix`         | Native rules + type errors (auto-fixes what it can) |
| `pnpm fast-lint` | `fast-lint src/ tests/ --fix`                   | `@ls-stack` rules (auto-fixes what it can)          |
| `pnpm typecheck` | `tsrs --fast` on every lib tsconfig             | Type checking only                                  |
| `pnpm format`    | `oxfmt`                                         | Formatting only, the whole repo                     |

**Always use pnpm scripts** — never rely on IDE diagnostics, they may be outdated.

## Process

1. Run `pnpm lint` to get all errors at once
2. Read and group errors by type/file
3. Fix all errors
4. Run `pnpm lint` again to verify — repeat until clean

## Critical: Fix Root Causes, Never Silence Errors

Every lint error signals a real issue. **Always fix the underlying problem** — never take shortcuts to make the error disappear.

Anti-patterns to **never** do:

- Casting with `as unknown as Type` to bypass a type mismatch — fix the mismatch at its source
- Adding a redundant null check or default value to silence a type error when the real issue is an incorrect type upstream
- Widening a function signature (e.g. accepting `undefined`) when the caller should provide a value
- Removing code that triggers an error instead of fixing why the error occurs
- Moving code around to dodge a lint rule without addressing what the rule protects against
- Replacing a specific type with a broader one (e.g. `Record<string, unknown>`) just to stop an error

When an error is hard to fix: **read the surrounding code to understand intent**, trace the types back to their source, and fix the root cause — even if it means changes across multiple files.

Use `__LEGIT_CAST__` only as a last resort. First prefer fixing upstream types, narrowing properly, validating `unknown` data with schemas, or changing unsafe boundaries to return `unknown` and validate in callers. Never use it to skip validation for persisted data, transport messages, network payloads, or other untrusted input. If it is truly unavoidable, keep it at the narrowest boundary and add the required `WORKAROUND:` explanation.

## Fix Rules

These are **strict project rules** — never work around them:

- **No `any`** — find the proper type
- **No `as Type` casts** — except `as const`
- **Avoid `__LEGIT_CAST__`** — use it only at genuine type-system boundaries after exhausting type-safe and schema-based alternatives
- **No non-null assertions (`!`)** — handle null/undefined properly (exception: allowed in test files)
- **No `@ts-expect-error` / `@ts-ignore`** — fix the actual type issue
- **No `oxlint-disable` / `fast-lint-disable` / `eslint-disable` comments** — always fix the root cause
- **No `_` prefix for unused vars** — remove the unused code entirely

## Diagnostics to Ignore

- **cSpell** diagnostic errors
