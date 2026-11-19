import { defineConfig, type StrictCastingOptions } from '@ls-stack/fast-lint';

// fast-lint runs the `@ls-stack` rules, the oxlint native rules are in
// `oxlint.config.ts`

function getNoTypeGuardsMessage(secondaryInstruction: string) {
  return `Check if the type guard can be inferred by typescript, in most cases it can, e.g. ".find((nullable) => nullable !== null)". ${secondaryInstruction} As last resort move the type guard to *.typeGuards.(ts|tsx) or *.type-guards.(ts|tsx) files.`;
}

const castFunctions: StrictCastingOptions['additionalCastFunctions'] = [
  { name: 'castToString', expectedType: 'string' },
  { name: 'castToNumber', expectedType: 'number' },
];

export default defineConfig({
  projects: ['tsconfig.json'],
  reportUnusedDisableDirectives: true,
  rules: {
    'improved-no-unnecessary-condition': 'error',
    'strict-casting': ['error', { additionalCastFunctions: castFunctions }],
    'no-restricted-syntax': [
      'error',
      {
        disallow: [
          {
            selector:
              'CallExpression[callee.property.name="toEqual"][arguments.0.type="ObjectExpression"]',
            message:
              'Avoid .toEqual with object values. Use .toMatchInlineSnapshot() instead.',
          },
          {
            selector:
              'CallExpression[callee.property.name="toEqual"][arguments.0.type="ArrayExpression"]',
            message:
              'Avoid .toEqual with array values. Use .toMatchInlineSnapshot() instead.',
          },
          {
            selector: 'CallExpression[callee.property.name="toMatchObject"]',
            message:
              'Avoid .toMatchObject. Use pick/omit to filter fields and .toMatchInlineSnapshot() instead.',
          },
          {
            selector:
              'CallExpression[callee.property.name="toMatchInlineSnapshot"][arguments.0.type="ObjectExpression"]',
            message:
              'Avoid .toMatchInlineSnapshot with object values. Only pass a string argument.',
          },
          {
            selector:
              'CallExpression[callee.property.name="toMatchInlineSnapshot"][arguments.0.type="ArrayExpression"]',
            message:
              'Avoid .toMatchInlineSnapshot with array values. Only pass a string argument.',
          },
        ],
      },
    ],
    // type names must be PascalCase
    'naming-convention': ['error', { values: false }],
    'no-unused-type-props-in-args': 'error',
    'no-optional-root-props': 'error',
    'require-description': ['error', { ignore: ['eslint'] }],
    'no-default-export': 'error',
    'use-top-level-regex': 'error',
    'use-types-directly-above-usage': 'error',
    'no-reexport': 'error',
    'no-type-guards': [
      'error',
      {
        alternativeMsgs: {
          inArrayFind: getNoTypeGuardsMessage(
            'If not, use findAndMap from @ls-stack/utils/arrayUtils.',
          ),
          inArrayFilter: getNoTypeGuardsMessage(
            'If not, use filterAndMap from @ls-stack/utils/arrayUtils.',
          ),
        },
      },
    ],
    'require-usage-explanation': [
      'error',
      {
        matches: [
          {
            fn: '__LEGIT_CAST__',
            commentPrefix: 'WORKAROUND:',
            message:
              '__LEGIT_CAST__ should only be used as a last resort. Always verify that no typesafe alternative exists before resorting to it.',
          },
        ],
      },
    ],
    'no-call-with-inferred-generics': [
      'error',
      {
        functions: [
          { name: '__LEGIT_CAST__', minGenerics: 2, disallowTypeOf: true },
        ],
      },
    ],
  },
  overrides: [
    {
      files: ['tests/**/*.{ts,tsx}'],
      rules: {
        'require-usage-explanation': 'off',
        // tests only check for unnecessary casts
        'strict-casting': [
          'error',
          {
            additionalCastFunctions: castFunctions,
            allowNullishCasting: true,
            allowAnyCasting: true,
            allowUnknownCasting: true,
          },
        ],
      },
    },
  ],
});
