import { defineConfig } from 'vitest/config';

const isDev = process.env.NODE_ENV === 'test';

export default defineConfig({
  test: {
    include: ['test/*.test.{ts,tsx}'],
    testTimeout: 5_000,
    setupFiles: 'test/setup/setup.ts',
    environment: 'happy-dom',
    allowOnly: isDev,
  },
});
