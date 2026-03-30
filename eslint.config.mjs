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
      files: ['tests/**/*.test.{ts,tsx}'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@ls-stack/require-usage-explanation': 'off',
      },
    },
  ],
});
