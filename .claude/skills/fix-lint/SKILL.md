---
name: fix-lint
description: Use this skill to identify and fix lint issues, like type errors and ESLint errors in the project. E.g. when user asks for "fix lint errors", "fix eslint errors", "fix type errors"
---

# Code Quality & Architecture Validation Expert

You are an expert at identifying and fixing ESLint errors and architecture violations while maintaining code quality and adhering to project standards. Your expertise lies in understanding lint rules, architecture constraints, applying proper fixes that address the root cause, and ensuring code remains maintainable, type-safe, and architecturally sound.

## When to Use This Skill

Use this skill when:

- There are ESLint errors in the codebase that need to be fixed
- After making code changes that may have introduced lint or architecture errors
- User explicitly requests to fix lint errors or architecture issues
- IDE diagnostics show ESLint warnings or errors
- Circular dependencies need to be resolved

## Core Responsibilities

### Error Analysis

Identify and understand lint and architecture errors:

- Run `pnpm eslint` to get the full list of ESLint errors
- Run `pnpm tsc` to check for type errors
- Analyze each error to understand the underlying issue
- Check if errors indicate deeper code quality or architectural problems
- Prioritize errors by severity and impact

### Fix Strategies

Apply proper fixes based on error type:

**Type Safety Errors:**

- Never use `any` - find the proper type
- Avoid `as` casts except for `as const`
- Remove non-null assertions ("!") - handle null/undefined properly
- Never use `@ts-expect-error` or `@ts-ignore` - fix the actual issue

**Code Quality Issues:**

- Remove unused variables and imports completely (don't prefix with `_`)
- Fix react-hooks dependencies - add missing deps or restructure code
- Properly handle async/await and promises
- Fix accessibility issues (jsx-a11y rules)

**Project-Specific Rules:**

- Never add `eslint-disable` comments - always fix the actual issue
- Follow TypeScript guidelines from CLAUDE.md
- Maintain component structure and organization
- Apply conditional styling rules (no template literal expressions)
- Use proper color variables from theme

### Validation

Ensure fixes are correct:

- Run `pnpm eslint` after fixes to verify all ESLint errors are resolved
- Run `pnpm tsc` to check for type errors introduced by fixes
- Verify functionality is preserved
- Check that fixes align with project coding standards and architecture patterns

## Fixing Process

Follow this systematic approach:

1. **Scan** - Run `pnpm eslint` get complete error list
2. **Analyze** - Group errors by type and identify patterns
3. **Prioritize** - Fix high-impact errors first, then work through systematically
4. **Fix** - Apply proper fixes that address root causes, not symptoms
5. **Verify ESLint** - Run `pnpm eslint` again to confirm all ESLint errors are resolved
6. **Type Check** - Run `pnpm tsc` to ensure no type errors were introduced

## Common Lint Errors and Fixes

### Unused Variables

```tsx
// ❌ Bad - prefixing with underscore
const _unused = getValue();

// ✅ Good - remove completely
// (code removed)
```

### React Hooks Dependencies

```tsx
// ❌ Bad - missing dependency
useEffect(() => {
  doSomething(value);
}, []);

// ✅ Good - add dependency or restructure
useEffect(() => {
  doSomething(value);
}, [value]);

// Or use useOnChange for cleaner code
useOnChange(value, () => {
  doSomething(value);
});
```

### Array.reduce Usage

```tsx
// ❌ Bad - using reduce
const total = items.reduce((sum, item) => sum + item.value, 0);

// ✅ Good - use for-of loop
let total = 0;
for (const item of items) {
  total += item.value;
}
```

## Quality Standards

Maintain these standards while fixing:

- **Never compromise type safety** - find proper types, don't use `any`
- **Fix root causes** - don't just suppress symptoms
- **Follow project patterns** - check CLAUDE.md for guidelines
- **Preserve functionality** - ensure code works the same after fixes
- **Improve readability** - fixes should make code clearer, not more complex
- **No eslint-disable** - this is absolutely forbidden in the project

## Communication Style

When fixing lint errors:

- List all errors found before starting fixes (both ESLint)
- Explain the fix strategy for complex errors
- Group similar fixes together for efficiency
- Report final status after running verification commands
- Suggest refactoring opportunities if patterns of errors indicate deeper issues

## Relevant notes

- ESLint is slow, run it only after all changes are complete
- **ALWAYS use pnpm scripts to get errors** - Do NOT rely on IDE diagnostics, they may be outdated or incomplete
- **Ignore these diagnostic warnings:**
  - cSpell diagnostic errors
  - `// FIX` comment warnings (from `unicorn/expiring-todo-comments`) - these are intentional TODO comments with optional dates, they must be handled only if user asks for it

## Goal

Fix all ESLint and architecture errors properly by addressing root causes, maintaining type safety, following project coding standards and architecture patterns, and ensuring the codebase is cleaner, more maintainable, and architecturally sound after fixes. Never use eslint-disable comments - every error should have a proper fix that improves code quality. Ensure all circular dependencies are resolved and architecture rules are respected.
