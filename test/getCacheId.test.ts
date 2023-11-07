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

test('nested objects are sorted', () => {
  expect(
    getCacheId({
      b: {
        d: 4,
        c: 3,
      },
      a: 1,
    }),
  ).toMatchInlineSnapshot(`"[{"a":1},{"b":[{"c":3},{"d":4}]}]"`);
});

test('nested objects in array are sorted', () => {
  expect(
    getCacheId({
      a: [
        {
          d: 4,
          c: 3,
        },
        {
          z: 1,
          a: 1,
        },
        1,
      ],
    }),
  ).toMatchInlineSnapshot(`"[{"a":[[{"c":3},{"d":4}],[{"a":1},{"z":1}],1]}]"`);
});

test('max default depth sortin = 3', () => {
  expect(
    getCacheId({
      object_type: 'test',
      page: 1,
      nested_type: 'onlyrefs',
      filters: [
        {
          field: 'single_select',
          type: 'string',
          operator: 'Exatamente igual',
          value: 'Option 1',
          not_sort: {
            z: 1,
            a: 1,
          }
        },
      ],
      size: 50,
    }),
  ).toMatchInlineSnapshot(`"[{"filters":[[{"field":"single_select"},{"not_sort":{"z":1,"a":1}},{"operator":"Exatamente igual"},{"type":"string"},{"value":"Option 1"}]]},{"nested_type":"onlyrefs"},{"object_type":"test"},{"page":1},{"size":50}]"`);
});
