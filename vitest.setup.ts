import { compactSnapshot } from '@ls-stack/utils/testUtils';
import { expect } from 'vitest';

expect.addSnapshotSerializer({
  test: (val) => typeof val !== 'string',
  serialize: (val) => compactSnapshot(val, { sortKeys: 'asc', rejectKeys: [] }),
});
