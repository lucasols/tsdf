import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/*.test.{ts,tsx}'],
    // testTimeout: 5_000,
    setupFiles: 'test/setup/setup.ts',
    environment: 'happy-dom',
  },
});
