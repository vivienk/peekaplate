import { defineConfig, devices } from '@playwright/test';

// Real SDK and real browser; all provider responses in this suite are synthetic HTTP fixtures.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'owner-auth-provider.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'auth-chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm --filter @peekaplate/console dev',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
    env: {
      VITE_OWNER_AUTH_ENABLED: 'true',
      VITE_SUPABASE_URL: 'https://auth-fixture.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_fixture_only',
      VITE_PUBLIC_API_URL: 'https://api.peekaplate.app',
      VITE_OWNER_AI_ENABLED: 'true',
    },
  },
});
