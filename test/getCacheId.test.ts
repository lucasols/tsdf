import { expect, test } from 'vitest';
import { getCacheId } from '../src/utils/getCacheId';

test('getCacheId ignore undefined obj values', () => {
  expect(
    getCacheId({
      a: 1,
      b: undefined,
      c: 3,
      und: undefined,
    }),
  ).toMatchInlineSnapshot('"[{"a":1},{"c":3}]"');
});
