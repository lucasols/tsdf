/// <reference types="vitest" />

import { defineConfig } from 'vitest';

export default defineConfig({
  test: {
    include: ['test/*.test.{ts,tsx}'],
    testTimeout: 2_000,
    setupFiles: 'test/setup/setup.ts',
  },
});
