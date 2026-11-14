import { defineConfig, devices } from '@playwright/test';

// Real SDK and UI, synthetic provider/API HTTP only. No real accounts or restaurant grants.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'owner-workspace.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'workspace-chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm --filter @peekaplate/console dev',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
    env: {
      VITE_OWNER_AUTH_ENABLED: 'true',
      VITE_SUPABASE_URL: 'https://auth-fixture.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_fixture_only',
      VITE_PUBLIC_API_URL: 'https://peekaplate-api-staging.vxkong.workers.dev',
    },
  },
});
