import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/restaurant-links',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/serve-restaurant-routing-test.mjs',
    url: 'http://127.0.0.1:5186/diner/',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
