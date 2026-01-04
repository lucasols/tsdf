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
  ).toMatchInlineSnapshot(`"{"a":[[{"c":3},{"d":4}],[{"a":1},{"z":1}],1]}"`);
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
          },
        },
      ],
      size: 50,
    }),
  ).toMatchInlineSnapshot(
    `"[{"filters":[[{"field":"single_select"},{"not_sort":{"z":1,"a":1}},{"operator":"Exatamente igual"},{"type":"string"},{"value":"Option 1"}]]},{"nested_type":"onlyrefs"},{"object_type":"test"},{"page":1},{"size":50}]"`,
  );
});

test('number cache id is not equal to string cache id', () => {
  expect(getCacheId(1) !== getCacheId('1')).toBeTruthy();
});

test('primitive values are not serialized', () => {
  expect(getCacheId('1')).toMatchInlineSnapshot(`"1"`);
  expect(getCacheId(true)).toMatchInlineSnapshot(`"#$true$#"`);
  expect(getCacheId(false)).toMatchInlineSnapshot(`"#$false$#"`);
  expect(getCacheId(null)).toMatchInlineSnapshot(`"#$null$#"`);
  expect(getCacheId(undefined)).toMatchInlineSnapshot(`"#$undefined$#"`);
});

test('objects with one key should not be sorted', () => {
  expect(
    getCacheId({
      a: {
        b: 1,
      },
    }),
  ).toMatchInlineSnapshot(`"{"a":{"b":1}}"`);
});

test('empty objects', () => {
  expect(
    getCacheId({
      a: {
        a: undefined,
      },
    }),
  ).toMatchInlineSnapshot(`"{"a":{}}"`);

  expect(
    getCacheId({
      a: {
        b: {},
      },
    }),
  ).toMatchInlineSnapshot(`"{"a":{"b":{}}}"`);

  expect(
    getCacheId({
      a: {},
      b: 1,
    }),
  ).toMatchInlineSnapshot(`"[{"a":{}},{"b":1}]"`);
});

test('undefined values should not change the equivalent not undefined objs', () => {
  const a = getCacheId({ tableId: 'users' });
  const b = getCacheId({ tableId: 'users', filters: undefined });

  expect(a === b).toBeTruthy();
});

test('undefined values in objects should not change the equivalent not undefined objs', () => {
  expect(
    getCacheId({
      a: undefined,
      b: undefined,
    }),
  ).toMatchInlineSnapshot(`"{}"`);

  expect(
    getCacheId({
      a: undefined,
      b: 1,
    }),
  ).toMatchInlineSnapshot(`"{"b":1}"`);
});

test('getCacheId handles arrays', () => {
  expect(getCacheId([1, 2, 3])).toMatchInlineSnapshot(`"[1,2,3]"`);
});

test('getCacheId handles nested arrays', () => {
  expect(getCacheId({ a: [1, 2, 3, [2, 1, 3]] })).toMatchInlineSnapshot(
    `"{"a":[1,2,3,[2,1,3]]}"`,
  );
});

test('a subset of a value can be checked via includes', () => {
  const subSetObj = { z: 0, a: 1, b: 2 };

  expect(
    getCacheId({
      a: 1,
      b: 2,
      c: subSetObj,
    }).includes(getCacheId(subSetObj)),
  ).toBeTruthy();
});
