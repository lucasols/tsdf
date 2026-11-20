import { defineConfig } from 'oxlint';

// oxlint runs the native rules and, through tsrs, the type-aware ones and the
// type check. The `@ls-stack` rules are in `fast-lint.config.ts`

export default defineConfig({
  plugins: ['typescript', 'unicorn', 'react', 'vitest'],
  categories: { correctness: 'off' },
  options: {
    typeAware: true,
    reportUnusedDisableDirectives: 'error',
    // oxlint rules use `oxlint-disable` comments, the rules that run on
    // fast-lint use `fast-lint-disable` comments
    respectEslintDisableDirectives: false,
  },
  rules: {
    // eslint recommended rules
    'for-direction': 'error',
    'no-async-promise-executor': 'error',
    'no-case-declarations': 'error',
    'no-compare-neg-zero': 'error',
    'no-cond-assign': 'error',
    'no-constant-binary-expression': 'error',
    'no-constant-condition': 'error',
    'no-control-regex': 'error',
    'no-debugger': 'error',
    'no-delete-var': 'error',
    'no-dupe-else-if': 'error',
    'no-duplicate-case': 'error',
    'no-empty': 'error',
    'no-empty-character-class': 'error',
    'no-empty-pattern': 'error',
    'no-empty-static-block': 'error',
    'no-ex-assign': 'error',
    'no-extra-boolean-cast': 'error',
    'no-fallthrough': 'error',
    'no-global-assign': 'error',
    'no-invalid-regexp': 'error',
    'no-irregular-whitespace': 'error',
    'no-loss-of-precision': 'error',
    'no-misleading-character-class': 'error',
    'no-nonoctal-decimal-escape': 'error',
    'no-regex-spaces': 'error',
    'no-self-assign': 'error',
    'no-shadow-restricted-names': 'error',
    'no-sparse-arrays': 'error',
    'no-unexpected-multiline': 'error',
    'no-unsafe-finally': 'error',
    'no-unsafe-optional-chaining': 'error',
    'no-unused-labels': 'error',
    'no-unused-private-class-members': 'error',
    'no-useless-backreference': 'error',
    'no-useless-catch': 'error',
    'no-useless-escape': 'error',
    'require-yield': 'error',
    'use-isnan': 'error',
    'valid-typeof': 'error',
    'no-var': 'error',
    'prefer-rest-params': 'error',
    'prefer-spread': 'error',
    'no-array-constructor': 'error',

    // typescript recommended rules
    'typescript/ban-ts-comment': 'error',
    'typescript/no-duplicate-enum-values': 'error',
    'typescript/no-empty-object-type': 'error',
    'typescript/no-explicit-any': 'error',
    'typescript/no-extra-non-null-assertion': 'error',
    'typescript/no-misused-new': 'error',
    'typescript/no-namespace': 'error',
    'typescript/no-non-null-asserted-optional-chain': 'error',
    'typescript/no-require-imports': 'error',
    'typescript/no-this-alias': 'error',
    'typescript/no-unnecessary-type-constraint': 'error',
    'typescript/no-unsafe-declaration-merging': 'error',
    'typescript/no-unsafe-function-type': 'error',
    'typescript/no-wrapper-object-types': 'error',
    'typescript/prefer-as-const': 'error',
    'typescript/prefer-namespace-keyword': 'error',
    'typescript/triple-slash-reference': 'error',

    // typescript type-aware recommended rules
    'typescript/await-thenable': 'error',
    'typescript/no-array-delete': 'error',
    'typescript/no-base-to-string': 'error',
    'typescript/no-duplicate-type-constituents': 'error',
    'typescript/no-floating-promises': 'error',
    'typescript/no-for-in-array': 'error',
    'typescript/no-implied-eval': 'error',
    'typescript/no-misused-promises': 'error',
    'typescript/no-redundant-type-constituents': 'error',
    'typescript/no-unnecessary-type-assertion': 'error',
    'typescript/no-unsafe-argument': 'error',
    'typescript/no-unsafe-call': 'error',
    'typescript/no-unsafe-enum-comparison': 'error',
    'typescript/no-unsafe-member-access': 'error',
    'typescript/no-unsafe-return': 'error',
    'typescript/no-unsafe-unary-minus': 'error',
    'typescript/prefer-promise-reject-errors': 'error',
    'typescript/require-await': 'error',
    'typescript/restrict-plus-operands': 'error',
    'typescript/restrict-template-expressions': 'error',
    'typescript/unbound-method': 'error',

    // eslint rules
    'object-shorthand': 'error',
    'no-useless-rename': 'error',
    'no-param-reassign': 'error',
    'prefer-template': 'error',
    'prefer-const': ['error', { destructuring: 'all' }],
    'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 't-state',
            importNames: ['deepEqual'],
            message: 'Use deepEqual from @ls-stack/utils/deepEqual instead.',
          },
        ],
        patterns: [{ group: ['*.test'], message: 'Do not import test files' }],
      },
    ],
    'no-implicit-coercion': [
      'error',
      { disallowTemplateShorthand: true, allow: ['!!'] },
    ],
    'no-unused-expressions': 'error',
    'no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '_$',
        ignoreRestSiblings: true,
        varsIgnorePattern: '_$',
      },
    ],
    'no-shadow': ['error', { ignoreOnInitialization: true, allow: ['expect'] }],

    // typescript rules
    'typescript/no-unnecessary-condition': [
      'error',
      { allowConstantLoopConditions: true, checkTypePredicates: true },
    ],
    'typescript/no-non-null-assertion': 'error',
    'typescript/consistent-type-assertions': [
      'error',
      { assertionStyle: 'never' },
    ],
    'typescript/only-throw-error': 'error',
    'typescript/no-deprecated': 'error',

    // react rules
    'react/rules-of-hooks': 'error',
    'react/exhaustive-deps': 'error',

    // unicorn rules
    'unicorn/require-array-join-separator': 'error',
    'unicorn/no-empty-file': 'error',
    'unicorn/no-array-reduce': ['error', { allowSimpleOperations: true }],
    'unicorn/no-array-for-each': 'error',

    // vitest rules
    'vitest/expect-expect': 'error',
    'vitest/no-identical-title': 'error',
  },
  overrides: [
    {
      files: ['tests/**/*.{ts,tsx}'],
      rules: { 'typescript/no-non-null-assertion': 'off' },
    },
    {
      // keep test files small enough to navigate and review, split large
      // suites by theme instead
      files: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
      rules: {
        'max-lines': [
          'error',
          { max: 2000, skipBlankLines: true, skipComments: true },
        ],
      },
    },
  ],
  ignorePatterns: ['dist', '**/*.d.ts'],
});
