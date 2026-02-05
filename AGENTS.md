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

# Run tests with UI
pnpm test:ui

# Run tests for changed files only
pnpm test:changed

# Full lint (TypeScript check + ESLint + Prettier)
pnpm lint

# Type check only
pnpm tsc

# Build (runs tests + lint first)
pnpm build

# Build without tests
pnpm build:no-test
```

### Running a Single Test

```bash
pnpm vitest run src/yourFile.test.ts
```

## Architecture

### Core Concepts

1. **Fetch Orchestrator** (`src-old/fetchOrquestrator.ts`): Manages fetch scheduling with priority levels (`lowPriority`, `highPriority`, `realtimeUpdate`) and throttling. Handles mutation coordination to prevent conflicts. <!-- cspell:ignore Orquestrator -->

2. **Store Types**:
   - `newTSDFDocumentStore`: Single entity with loading states, refetch on mount, and optimistic updates
   - `newTSDFCollectionStore`: Key-value store where each item is fetched independently by payload
   - `newTSDFListQueryStore`: Combines list queries with individual item queries, supports pagination

3. **State Shape**: Each store tracks `data`, `error`, `status` (loading/success/error/refetching), `refetchOnMount` flag, and `wasLoaded` for determining initial fetch behavior.

### Key Patterns

- Uses `t-state` for underlying state management with selectors and subscriptions
- `evtmitter` for event-based invalidation across store instances
- `immer` for immutable state updates via `produceState`
- `klona` for deep cloning payloads

### File Structure

- `src-old/`: Current working source code (being migrated)
- `test-old/`: Current test files
- `src/`: New implementation (in progress)

## Testing

Tests use Vitest with `happy-dom` environment. Test files follow the pattern `src/*.test.{ts,tsx}`.

- Prefer using toMatchInlineSnapshot instead of toBe or toEqual for object assertions
- Tests use a YAML snapshot serializer instead of the default vitest snapshot serializer. Using `compactSnapshot` from `@ls-stack/utils/testUtils` to serialize the snapshot. Boolean values are serialized as `❌` or `✅` instead of `true` or `false`.
- Tests should be optimized for human readability
- Prefer using vitest fake timers
- Use `createLoggerStore` util for create a human readable values timelines for snapshot testing

## TypeScript Configuration

- Strict mode enabled with `noUncheckedIndexedAccess`
- Target: ESNext
- Uses `tsconfig.prod.json` for builds (emits declarations)

## General Guidelines

- Strive for simple solutions, avoid unnecessary complexity
