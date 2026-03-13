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

console.error = (...args) => {
  if (
    args.length > 0 &&
    typeof args[0] === 'string' &&
    args[0].includes('was not wrapped in act')
  ) {
    throw new Error(format(...args));
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
