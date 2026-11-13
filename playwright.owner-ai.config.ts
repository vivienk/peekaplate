import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/owner-ai-browser',
  workers: 1,
  retries: 0,
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  webServer: {
    command: 'node --import ./scripts/node-ts-hooks.mjs backend/scripts/owner-ai-local.ts',
    env: { OWNER_AI_LOCAL_MOCK: 'true' },
    url: 'http://127.0.0.1:5174/owner-dashboard.html',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
