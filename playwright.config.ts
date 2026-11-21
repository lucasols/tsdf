import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/playwright',
  // Per test, including its hooks and fixtures
  timeout: 30_000,
  // Caps the whole run (a full run takes about 30s), so a run that never
  // finishes fails instead of blocking `pnpm test:all` and the publish. Pass
  // `--global-timeout=0` for long local runs such as `--repeat-each`.
  globalTimeout: 5 * 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:42173',
    trace: 'on-first-retry',
    // Without these, a stuck click or navigation waits for the whole test
    // timeout and the failure doesn't say which step hung
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  webServer: {
    command:
      'pnpm exec vite --config playwright.fixture.vite.config.ts --host 127.0.0.1 --port 42173',
    url: 'http://127.0.0.1:42173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chrome',
      // Uses the locally installed Google Chrome instead of a Playwright-managed
      // Chromium build, so Playwright upgrades never trigger a browser download
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
});
