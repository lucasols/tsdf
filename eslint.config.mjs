// @ts-check
import { lsStackEslintCfg } from '@ls-stack/eslint-cfg';
import reactHooks from 'eslint-plugin-react-hooks';

export default lsStackEslintCfg({
  tsconfigRootDir: import.meta.dirname,
  ignore: ['src-old/**/*', 'test-old/**/*'],
  extraRuleGroups: [
    {
      plugins: {
        'react-hooks': reactHooks,
      },
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
      },
    },
  ],
});
