/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { format } from 'pretty-format';
import { expect } from 'vitest';
import { filterAndMap } from '../../src/utils/filterAndMap';
import { createOrVariations } from '../utils/createOrVariations';
import { dedent } from '../utils/dedent';

expect.extend({
  toMatchTimeline(received, expected) {
    const expectedPossibleValues: string[] = createOrVariations(expected);

    function checkIfPass(_received: any, _expected: any) {
      let normalizedExpected: string = dedent`${_expected}`;

      normalizedExpected = filterAndMap(
        normalizedExpected.split('\n'),
        (action, ignore) => {
          if (action === '.') {
            return dedent`fetch-started : 1
          fetch-finished : 1
          fetch-ui-commit`;
          }

          if (action.trim() === '' || action === '"') {
            return ignore;
          }

          return dedent`${action}`;
        },
      ).join('\n');

      normalizedExpected = `\n${normalizedExpected}\n`;

      const normalizedReceived = String(_received)
        .split('\n')
        .map((action) => dedent`${action}`)
        .join('\n');

      return {
        pass: normalizedReceived === normalizedExpected,
        normalizedExpected,
        normalizedReceived,
      };
    }

    for (const possibleValue of expectedPossibleValues) {
      const {
        pass: possiblePass,
        normalizedExpected,
        normalizedReceived,
      } = checkIfPass(received, possibleValue);

      if (possiblePass || possibleValue === expectedPossibleValues.at(-1)) {
        return {
          pass: possiblePass,
          message: () => `Timeline does not match`,
          actual: normalizedReceived,
          expected: normalizedExpected,
        };
      }
    }

    return {
      pass: false,
      message: () => `Timeline does not match`,
      actual: received,
      expected,
    };
  },
  toMatchInlineSnapshotString(received, expected) {
    const normalizedExpected = dedent(expected);
    const normalizedReceived = format(received, {
      printBasicPrototype: false,
      escapeString: false,
    });

    return {
      pass: normalizedReceived === normalizedExpected,
      message: () => `Snapshot string does not match`,
      actual: normalizedReceived,
      expected: normalizedExpected,
    };
  },
});
