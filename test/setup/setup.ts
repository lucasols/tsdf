/* eslint-disable @typescript-eslint/no-empty-interface */
/* eslint-disable @typescript-eslint/no-namespace */
import { expect } from 'vitest';
import matchers, {
  TestingLibraryMatchers,
} from '@testing-library/jest-dom/matchers';
import { dedent } from '../utils/dedent';
import { filterAndMap } from '../../src/utils/filterAndMap';

interface ToMatchTimeline<R = unknown> {
  toMatchTimeline(timeline: string): R;
}

declare global {
  namespace Vi {
    interface Assertion extends ToMatchTimeline {}

    interface JestAssertion<T = any>
      extends jest.Matchers<void, T>,
        TestingLibraryMatchers<T, void> {}
  }
}

expect.extend(matchers);

expect.extend({
  toMatchTimeline(received, expected) {
    const expectedPossibleValues: string[] = (() => {
      const result: string[] = [];

      if (expected.includes('OR')) {
        const [, orBlock = ''] = /---([\s\S]+)---/.exec(expected) || [];

        const orGroups = orBlock.split('OR');

        for (const orGroup of orGroups) {
          result.push(expected.replace(/---([\s\S]+)---/, orGroup));
        }

        return result;
      } else {
        return [expected];
      }
    })();

    function checkIfPass(_received: any, _expected: any) {
      let normalizedExpected: string = dedent`${_expected}`;

      normalizedExpected = filterAndMap(
        normalizedExpected.split('\n'),
        (action, ignore) => {
          if (action === '.') {
            return dedent`fetch-started
          fetch-finished
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
});
