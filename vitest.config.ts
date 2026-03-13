import { defineConfig } from 'vitest/config';

const isDev = process.env.NODE_ENV === 'test';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    testTimeout: 1_000,
    environment: 'happy-dom',
    execArgv: ['--no-experimental-webstorage'],
    allowOnly: isDev,
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
  },
});
