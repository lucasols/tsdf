import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/playwright',
  timeout: 30_000,
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:42173', trace: 'on-first-retry' },
  webServer: {
    command:
      'pnpm exec vite --config playwright.fixture.vite.config.ts --host 127.0.0.1 --port 42173',
    url: 'http://127.0.0.1:42173',
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
