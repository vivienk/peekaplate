import { defineConfig, devices } from '@playwright/test';

// Synthetic ingestion token. Tests intercept every PostHog request; nothing goes to PostHog.
const env = {
  VITE_POSTHOG_ENABLED: 'true',
  VITE_POSTHOG_KEY: 'phc_browser_test_fixture',
  VITE_POSTHOG_HOST: 'https://us.i.posthog.com',
  VITE_POSTHOG_ENVIRONMENT: 'staging',
};
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['posthog.spec.ts', 'posthog-adapter.spec.ts'],
  fullyParallel: true,
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  webServer: [5173, 5174].map((port) => ({
    command: `pnpm --filter @peekaplate/${port === 5173 ? 'diner' : 'console'} exec vite --host 127.0.0.1 --port ${port} --strictPort --mode staging`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    env: { ...env, VITE_POSTHOG_ALLOWED_ORIGIN: `http://127.0.0.1:${port}` },
  })),
});
