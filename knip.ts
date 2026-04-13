const config = {
  entry: ['playwright-fixture/src/main.tsx'],
  project: [
    'src/**/*.{ts,tsx}',
    'tests/**/*.{ts,tsx}',
    'scripts/**/*.{ts,tsx}',
    'playwright-fixture/src/**/*.{ts,tsx}',
  ],
};

export default config;
