import { describe, expect, test } from 'vitest';
import { createOrVariations } from './utils/createOrVariations';

describe('createOrVariations', () => {
  test('case 1', () => {
    expect(
      createOrVariations(`
      4 - mutation-started
      ---
      fetch-aborted : 3
      4 - mutation-finished
      OR
      4 - mutation-finished
      fetch-aborted : 3
      ---

      fetch-started : 5
    `),
    ).toMatchInlineSnapshot(`
      [
        "
            4 - mutation-started
            fetch-aborted : 3
            4 - mutation-finished

            fetch-started : 5
          ",
        "
            4 - mutation-started
            4 - mutation-finished
            fetch-aborted : 3

            fetch-started : 5
          ",
      ]
    `);
  });

  test('case 2', () => {
    expect(
      createOrVariations(`
      4 - mutation-started
      ---
      fetch-aborted : 3
      4 - mutation-finished
      test
      OR
      4 - mutation-finished
      fetch-aborted : 3
      test
      OR
      test
      4 - mutation-finished
      fetch-aborted : 3
      ---

      fetch-started : 5
    `),
    ).toMatchInlineSnapshot(`
      [
        "
            4 - mutation-started
            fetch-aborted : 3
            4 - mutation-finished
            test

            fetch-started : 5
          ",
        "
            4 - mutation-started
            4 - mutation-finished
            fetch-aborted : 3
            test

            fetch-started : 5
          ",
        "
            4 - mutation-started
            test
            4 - mutation-finished
            fetch-aborted : 3

            fetch-started : 5
          ",
      ]
    `);
  });
});
