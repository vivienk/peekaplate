import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'portion-landscape.spec.ts',
  workers: 1,
  use: { ...devices['Desktop Chrome'], hasTouch: true, trace: 'retain-on-failure' },
});
