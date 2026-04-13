import { format } from 'node:util';
import { compactSnapshot } from '@ls-stack/utils/testUtils';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { __resetSessionOfflineCoordinatorRegistryForTests } from './src/persistentStorage/offline/sessionCoordinator';

process.env.NODE_ENV = 'development';

expect.addSnapshotSerializer({
  test: (val) => typeof val !== 'string',
  serialize: (val) =>
    compactSnapshot(val, {
      sortKeys: 'asc',
      rejectKeys: [],
      maxLineLength: 80,
    }),
});

const originalConsoleError = console.error;

declare global {
  var __SUPPRESS_ACT_ERROR__: boolean;
}

globalThis.__SUPPRESS_ACT_ERROR__ = false;

console.error = (...args) => {
  let skipOriginal = false;
  if (args.length > 0 && typeof args[0] === 'string') {
    const errorMsg = args[0];

    if (errorMsg.includes('You seem to have overlapping act() calls')) {
      return;
    }

    if (errorMsg.includes('was not wrapped in act')) {
      if (!globalThis.__SUPPRESS_ACT_ERROR__) {
        throw new Error(
          `${format(...args)} If this comes from intentional reactive test tracking rather than a missing act, wrap only the smallest needed section with await withSuppressedActError(async () => { ... }) from tests/utils/withSuppressedActError.ts.`,
        );
      }

      skipOriginal = true;
    }

    if (errorMsg.includes('Maximum update depth exceeded')) {
      throw new Error(format(...args));
    }
  }
  if (!skipOriginal) originalConsoleError(...args);
};

const defaultNavigatorLocks = {
  request: vi.fn(
    async <T>(_name: string, callback: () => T | Promise<T>) =>
      await callback(),
  ),
};

beforeEach(() => {
  __resetSessionOfflineCoordinatorRegistryForTests();
  Object.defineProperty(globalThis.navigator, 'locks', {
    value: defaultNavigatorLocks,
    writable: true,
    configurable: true,
  });
  defaultNavigatorLocks.request.mockClear();
});

afterEach(() => {
  __resetSessionOfflineCoordinatorRegistryForTests();
  Object.defineProperty(globalThis.navigator, 'locks', {
    value: defaultNavigatorLocks,
    writable: true,
    configurable: true,
  });
});
