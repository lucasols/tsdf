import { defineConfig } from 'vitest/config';

const isDev = process.env.NODE_ENV === 'test';

export default defineConfig({
  test: {
    include: ['src/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    testTimeout: 5_000,
    environment: 'happy-dom',
    allowOnly: isDev,
  },
});
