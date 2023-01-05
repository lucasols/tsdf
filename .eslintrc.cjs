const isCI = process.env.CI === 'true';

const OFF = 0;
const WARN = 1;
const ERROR = 2;
const ERROR_IN_CI = isCI ? ERROR : WARN;
const ERROR_IN_CI_ONLY = isCI ? ERROR : 0;

module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    createDefaultProgram: true,
    ecmaVersion: 8,
    ecmaFeatures: {
      jsx: true,
    },
    useJSXTextNode: true,
    sourceType: 'module',
  },
  env: {
    browser: true,
  },
  plugins: ['@typescript-eslint'],

  rules: {
    'no-warning-comments': [WARN, { terms: ['FIX:'] }],
    'no-constant-binary-expression': ERROR_IN_CI,
    'object-shorthand': ERROR_IN_CI,
    'no-useless-rename': ERROR_IN_CI,
    'no-param-reassign': ERROR_IN_CI,
    'prefer-template': ERROR_IN_CI,

    'no-prototype-builtins': OFF,
    'no-inner-declarations': OFF,
    'no-undef': OFF,
    'no-console': [ERROR_IN_CI, { allow: ['warn', 'error', 'info'] }],
    'no-restricted-imports': [
      ERROR_IN_CI,
      {
        patterns: [
          {
            group: ['*.test'],
            message: 'Do not import test files',
          },
        ],
      },
    ],

    /* typescript */
    '@typescript-eslint/no-unnecessary-condition': ERROR_IN_CI,
    '@typescript-eslint/naming-convention': [
      'error',
      {
        selector: 'typeLike',
        format: ['PascalCase'],
      },
    ],
    '@typescript-eslint/no-throw-literal': ERROR_IN_CI,
    '@typescript-eslint/no-unused-expressions': ERROR_IN_CI,
    '@typescript-eslint/no-unused-vars': [
      ERROR_IN_CI,
      { argsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-shadow': [
      ERROR_IN_CI,
      { ignoreOnInitialization: true },
    ],
    'no-restricted-syntax': [
      ERROR_IN_CI_ONLY,
      {
        selector:
          'CallExpression[callee.object.name="test"][callee.property.name="only"]',
        message: 'No test.only',
      },
    ],

    '@typescript-eslint/no-non-null-assertion': OFF,
    '@typescript-eslint/no-empty-function': OFF,
    '@typescript-eslint/no-explicit-any': OFF,
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
};
