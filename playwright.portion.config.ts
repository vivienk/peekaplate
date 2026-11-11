import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: [
    'portion.spec.ts',
    'menu-states.spec.ts',
    'published-integrity.spec.ts',
    'published-refresh.spec.ts',
  ],
  timeout: 45_000,
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm --filter @peekaplate/diner dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
  },
});
