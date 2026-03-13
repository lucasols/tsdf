import { compactSnapshot } from '@ls-stack/utils/testUtils';
import { format } from 'node:util';
import { afterEach, beforeEach, expect, vi } from 'vitest';

process.env.NODE_ENV = 'development';

expect.addSnapshotSerializer({
  test: (val) => typeof val !== 'string',
  serialize: (val) =>
    compactSnapshot(val, {
      sortKeys: 'asc',
      rejectKeys: [],
      maxLineLength: 80,
      replaceValues(value) {
        if (value instanceof Error) {
          value.stack = undefined;
          return { newValue: value };
        }

        return false;
      },
    }),
});

const originalConsoleError = console.error;

declare global {
  var __SUPPRESS_ACT_ERROR__: boolean;
}

globalThis.__SUPPRESS_ACT_ERROR__ = false;

console.error = (...args) => {
  if (args.length > 0 && typeof args[0] === 'string') {
    const errorMsg = args[0];
    if (
      errorMsg.includes('was not wrapped in act') &&
      !globalThis.__SUPPRESS_ACT_ERROR__
    ) {
      throw new Error(
        `${format(...args)} If the warning not comes from tests with missing act, use globalThis.__SUPPRESS_ACT_ERROR__ = true; to ignore it.`,
      );
    }

    if (errorMsg.includes('Maximum update depth exceeded')) {
      throw new Error(format(...args));
    }
  }
  originalConsoleError(...args);
};

const defaultNavigatorLocks = {
  request: vi.fn(
    async <T>(_name: string, callback: () => T | Promise<T>) =>
      await callback(),
  ),
};

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'locks', {
    value: defaultNavigatorLocks,
    writable: true,
    configurable: true,
  });
  defaultNavigatorLocks.request.mockClear();
});

afterEach(() => {
  Object.defineProperty(globalThis.navigator, 'locks', {
    value: defaultNavigatorLocks,
    writable: true,
    configurable: true,
  });
});
