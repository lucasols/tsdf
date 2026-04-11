// @ts-check
import { lsStackEslintCfg } from '@ls-stack/eslint-cfg';
import reactHooks from 'eslint-plugin-react-hooks';

export default lsStackEslintCfg({
  tsconfigRootDir: import.meta.dirname,
  ignore: ['src-old/**/*', 'test-old/**/*'],
  extraRuleGroups: [
    {
      plugins: { 'react-hooks': reactHooks },
      rules: {
        'react-hooks/rules-of-hooks': 'error',
        'react-hooks/exhaustive-deps': 'warn',
        '@typescript-eslint/no-deprecated': 'error',
        '@ls-stack/prefer-named-functions': 0,
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: 't-state',
                importNames: ['deepEqual'],
                message:
                  'Use deepEqual from @ls-stack/utils/deepEqual instead.',
              },
            ],
          },
        ],
        'no-restricted-syntax': [
          'error',
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
          {
            selector:
              ':matches(PropertyDefinition, MethodDefinition)[accessibility="private"]',
            message: 'Use #private instead',
          },
        ],
        '@ls-stack/require-usage-explanation': [
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
        '@ls-stack/no-call-with-inferred-generics': [
          'error',
          {
            functions: [
              { name: '__LEGIT_CAST__', minGenerics: 2, disallowTypeOf: true },
            ],
          },
        ],
      },
    },
    {
      files: ['tests/**/*.{ts,tsx}'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@ls-stack/require-usage-explanation': 'off',
      },
    },
  ],
});
