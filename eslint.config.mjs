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
        '@ls-stack/no-call-with-inferred-generics': [
          'error',
          {
            functions: [
              { name: '__LEGIT_CAST__', minGenerics: 2, disallowTypeOf: true },
            ],
          },
        ],
        'no-restricted-syntax': [
          'error',
          {
            selector:
              ':matches(PropertyDefinition, MethodDefinition)[accessibility="private"]',
            message: 'Use #private instead',
          },
        ],
      },
    },
    {
      files: ['tests/**/*.test.{ts,tsx}'],
      rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
    },
  ],
});
