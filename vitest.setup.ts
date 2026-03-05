import { compactSnapshot } from '@ls-stack/utils/testUtils';
import { format } from 'node:util';
import { expect } from 'vitest';

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
