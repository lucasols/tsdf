import { describe, expect, test } from 'vitest';

import { sortBy } from '../src/utils/sortBy';

test('default props', () => {
  expect(
    sortBy<[number, string]>(
      [
        [1, '2021-07-01'],
        [2, '2021-07-06'],
        [1, '2021-07-08'],
      ],
      (item) => item,
    ),
  ).toStrictEqual([
    [1, '2021-07-01'],
    [1, '2021-07-08'],
    [2, '2021-07-06'],
  ]);
});

test('have different levels order', () => {
  expect(
    sortBy<[number, string]>(
      [
        [0, '2021-07-01'],
        [0, '2021-07-06'],
        [0, '2021-07-08'],
      ],
      (item) => {
        return item;
      },
      {
        order: ['desc', 'asc'],
      },
    ),
  ).toStrictEqual([
    [0, '2021-07-01'],
    [0, '2021-07-06'],
    [0, '2021-07-08'],
  ]);
});

describe('handles infinity', () => {
  test('highest to lower', () => {
    expect(
      sortBy<[number, string | number]>(
        [
          [0, '2021-07-01'],
          [0, '2021-07-06'],
          [0, '2021-07-08'],
          [0, Infinity],
          [0, Infinity],
        ],
        (item) => {
          return item;
        },
        {
          order: ['desc', 'desc'],
        },
      ),
    ).toStrictEqual([
      [0, Infinity],
      [0, Infinity],
      [0, '2021-07-08'],
      [0, '2021-07-06'],
      [0, '2021-07-01'],
    ]);
  });

  test('lowest to higher', () => {
    expect(
      sortBy<[number, string | number]>(
        [
          [0, '2021-07-08'],
          [0, '2021-07-01'],
          [0, Infinity],
          [0, '2021-07-06'],
          [0, Infinity],
        ],
        (item) => {
          return item;
        },
        {
          order: ['desc', 'asc'],
        },
      ),
    ).toStrictEqual([
      [0, '2021-07-01'],
      [0, '2021-07-06'],
      [0, '2021-07-08'],
      [0, Infinity],
      [0, Infinity],
    ]);
  });
});

test('sort by single level', () => {
  expect(
    sortBy<[number, string]>(
      [
        [4, '2021-07-01'],
        [2, '2021-07-06'],
        [1, '2021-07-08'],
      ],
      (item) => item[0],
    ),
  ).toStrictEqual([
    [1, '2021-07-08'],
    [2, '2021-07-06'],
    [4, '2021-07-01'],
  ]);
});

test('sort by single level desc', () => {
  expect(
    sortBy<[number, string]>(
      [
        [4, '2021-07-01'],
        [2, '2021-07-06'],
        [1, '2021-07-08'],
      ],
      (item) => item[0],
      {
        order: 'desc',
      },
    ),
  ).toStrictEqual([
    [4, '2021-07-01'],
    [2, '2021-07-06'],
    [1, '2021-07-08'],
  ]);
});
